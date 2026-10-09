/**
 * Scheduler: decide o que pode rodar agora.
 *
 * Uma task é despachada só se as três portas estiverem abertas:
 *   1. dependências satisfeitas  (não basta "em andamento" — precisa integrada)
 *   2. sem conflito de arquivo   (com quem está rodando AGORA, não com quem já rodou)
 *   3. abaixo do teto de concorrência
 *
 * A diferença entre 1 e 2 é o ponto central do arquivo. Dependência é ordem.
 * Conflito é exclusão mútua: duas tasks independentes que tocam o mesmo arquivo
 * NÃO podem rodar juntas, mesmo sem nenhuma dependência declarada.
 */

import { ESTADOS_ATIVOS, ESTADOS_TERMINAIS } from './taskstore.mjs'
import { colidem, ordenarTopologicamente } from './planner.mjs'
import { arquivosEmConflito } from './git.mjs'

/**
 * @param {object} opts
 * @param {object[]} opts.tasks        todas as tasks
 * @param {number}   opts.concurrency  teto de agentes em paralelo
 * @param {string[]} opts.claimFiles   arquivos Reivindicados por quem está rodando
 */
export function selecionarDespachaveis({ tasks, concurrency, claimFiles = {} }) {
  const porId = new Map(tasks.map((t) => [t.id, t]))
  const rodando = tasks.filter((t) => ESTADOS_ATIVOS.includes(t.estado))

  const candidatos = tasks.filter((t) => {
    if (ESTADOS_TERMINAIS.includes(t.estado)) return false
    if (ESTADOS_ATIVOS.includes(t.estado)) return false
    if (t.estado === 'bloqueada') return false
    if (t.estado === 'aguardando-revisao' || t.estado === 'aguardando-integracao') return false
    return dependenciasSatisfeitas(t, porId)
  })

  // Maior prioridade primeiro; desempate por risco (risco alto antes) e por id.
  candidatos.sort((a, b) => {
    if (b.prioridade !== a.prioridade) return b.prioridade - a.prioridade
    const peso = { alto: 3, medio: 2, baixo: 1 }
    if ((peso[b.risco] || 0) !== (peso[a.risco] || 0)) return (peso[b.risco] || 0) - (peso[a.risco] || 0)
    return String(a.id).localeCompare(String(b.id))
  })

  const selecionados = []
  // Normaliza {taskId: [arquivos]} para o formato "taskId:arquivo" -> taskId,
  // que é o que a verificação de conflito consulta. Sem esta normalização o
  // conflito contra quem já está rodando nunca é detectado.
  const claimsLocais = {}
  for (const [taskId, arquivos] of Object.entries(claimFiles)) {
    for (const f of arquivos || []) claimsLocais[`${taskId}:${f}`] = taskId
  }

  for (const cand of candidatos) {
    if (selecionados.length + rodando.length >= concurrency) break

    // Conflito contra quem JÁ está rodando.
    const meusArquivos = claimFiles[cand.id] || cand.arquivosAlvo || []
    const conflitoRodando = conflitoComClaim(meusArquivos, claimsLocais, cand.id)
    if (conflitoRodando) continue

    // Conflito contra quem foi selecionado AGORA no mesmo ciclo.
    const conflitoNoCiclo = selecionados.some((s) => {
      const a = claimFiles[cand.id] || cand.arquivosAlvo || []
      const b = claimFiles[s.id] || s.arquivosAlvo || []
      return intersectam(a, b)
    })
    if (conflitoNoCiclo) continue

    selecionados.push(cand)
    for (const f of meusArquivos) claimsLocais[`${cand.id}:${f}`] = cand.id
  }

  return { despachaveis: selecionados, rodando }
}

/**
 * Dependência só está satisfeita quando a task de origem está CONCLUÍDA e
 * integrated. Se só terminou mas não foi integrada, a dependente produziria
 * código contra uma base que ainda não tem a mudança — que é exatamente o
 * "agente trabalhando com informação desatualizada".
 */
export function dependenciasSatisfeitas(task, porId) {
  for (const depId of task.dependsOn || []) {
    const dep = porId.get(depId)
    if (!dep) return false // dependência inexistente: trata como não satisfeita
    if (dep.estado !== 'concluida') return false
    if (dep.estado === 'concluida' && dep.integradaEm === undefined && dep.exigeIntegracao) return false
  }
  return true
}

/** Detailha o que falta para uma task virar despachável. */
export function motivoBloqueio(task, tasks) {
  const porId = new Map(tasks.map((t) => [t.id, t]))
  const pendentes = []
  for (const depId of task.dependsOn || []) {
    const dep = porId.get(depId)
    if (!dep) {
      pendentes.push(`${depId} (não existe)`)
    } else if (dep.estado !== 'concluida') {
      pendentes.push(`${depId} (${dep.estado})`)
    }
  }
  if (pendentes.length) {
    return { tipo: 'dependencia', mensagem: `Aguardando: ${pendentes.join(', ')}`, pendentes }
  }
  return null
}

function intersectam(a, b) {
  for (const x of a || []) {
    for (const y of b || []) {
      if (colidem(x, y)) return true
    }
  }
  return false
}

function conflitoComClaim(meusArquivos, claimsLocais, meuId) {
  for (const f of meusArquivos || []) {
    for (const [chave, dono] of Object.entries(claimsLocais)) {
      if (dono === meuId) continue
      const arquivoOutro = chave.slice(dono.length + 1)
      if (colidem(f, arquivoOutro)) return { arquivo: f, comTask: dono }
    }
  }
  return null
}

/**
 * Recalcula os estados derivados: o que está esperando dependência vira
 * `aguardando-dependencia`, o que ficou livre vira `pronta`. Rodar isso é o que
 * faz o orquestrador se recuperar sozinho depois de um restart, sem o usuário
 * precisar reclassificar nada.
 */
export function reconciliarEstados(store) {
  const tasks = store.listar()
  const porId = new Map(tasks.map((t) => [t.id, t]))
  const mudancas = []

  for (const t of tasks) {
    if (ESTADOS_TERMINAIS.includes(t.estado)) continue
    if (t.estado === 'aguardando-revisao' || t.estado === 'aguardando-integracao') continue

    const motivo = motivoBloqueio(t, tasks)
    const deveEsperar = Boolean(motivo)
    const atual = t.estado

    if (deveEsperar && (atual === 'pendente' || atual === 'pronta')) {
      store.mudarEstado(t.id, 'aguardando-dependencia', {}, motivo.mensagem)
      mudancas.push({ id: t.id, de: atual, para: 'aguardando-dependencia', motivo: motivo.mensagem })
    } else if (!deveEsperar && atual === 'aguardando-dependencia') {
      store.mudarEstado(t.id, 'pronta', {}, 'Dependências satisfeitas')
      mudancas.push({ id: t.id, de: atual, para: 'pronta' })
    } else if (!deveEsperar && atual === 'pendente') {
      store.mudarEstado(t.id, 'pronta', {}, 'Sem dependências pendentes')
      mudancas.push({ id: t.id, de: atual, para: 'pronta' })
    }
  }

  return mudancas
}

/**
 * Detecta conflito entre duas branches JÁ prontas para integrar, comparando o
 * conjunto real de arquivos alterados por cada uma. É o teste que roda na hora
 * da integração, quando já não dá para mudar o paralelismo.
 */
export function conflitosEntreBranches({ branches }) {
  const conflitos = []
  const ids = branches.map((b) => b.taskId)
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const inter = arquivosEmConflito(branches[i].arquivos || [], branches[j].arquivos || [])
      if (inter.length) {
        conflitos.push({
          a: branches[i].taskId,
          b: branches[j].taskId,
          arquivos: inter,
          resolucao: branches[i].dependeDe?.includes(branches[j].taskId) || branches[j].dependeDe?.includes(branches[i].taskId)
            ? 'Ordem resolvida por dependência: integrar na ordem do grafo.'
            : 'Conflito manual: as duas branches alteram os mesmos arquivos sem relação de dependência.',
        })
      }
    }
  }
  return conflitos.filter((c) => c.resolucao.startsWith('Conflito manual') || c.arquivos.length)
}

/** Ordem em que as branches aprovadas devem ser integradas. */
export function ordemDeIntegracao(tasks) {
  const comBranch = tasks.filter((t) => t.branch && t.estado === 'aguardando-integracao')
  try {
    return ordenarTopologicamente(comBranch)
  } catch {
    // Ciclo entre branches prontas: integra na ordem de prioridade e deixa o
    // merge real decidir. Melhor integrar assim do que travar.
    return comBranch.sort((a, b) => (b.prioridade || 0) - (a.prioridade || 0))
  }
}