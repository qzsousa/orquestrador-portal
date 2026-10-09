/**
 * Planner: transforma uma lista de tarefas soltas em um grafo executável.
 *
 * Três responsabilidades, nesta ordem:
 *   1. quebrar tarefa grande em subtarefas (checklist do Trello vira subtarefa)
 *   2. deduzir dependências que ninguém declarou
 *   3. prever quais tasks vão mexer nos mesmos arquivos
 *
 * O passo 2 é o que evita o problema clássico: dois agentes alterando o mesmo
 * contrato ao mesmo tempo, cada um com razão, e um merge quebrado no fim.
 */

import { arquivosEmConflito } from './git.mjs'

/**
 * Extrai subtarefas de checklists.
 *
 * O Trello é a fonte, e card de card vem com checklist. Um card com 4 itens é
 * quase sempre 4 tarefas — não 1 tarefa com 4 partes. Sem esta etapa o
 * orquestrador manda um agente fazer tudo e não há como paralelizar nem
 * revisar item por item.
 */
export function subtarefasDeChecklist(task, itens) {
  const subtarefas = []
  const dependenciasAnteriores = []
  for (const item of itens || []) {
    if (!item || !item.trim()) continue
    const id = task.id + '.' + (subtarefas.length + 1)
    subtarefas.push({
      id,
      titulo: item.trim(),
      descricao: `Subtarefa de ${task.id}: ${item.trim()}`,
      componentes: task.componentes || [],
      criterios: [`A subtarefa "${item.trim()}" está implementada e verificada`],
      // Cada item do checklist depende do anterior por padrão: num checklist
      // ordered, os itens são uma sequência, não paralelas.
      dependsOn: [...dependenciasAnteriores],
      prioridade: task.prioridade,
      risco: task.risco,
      origem: { ...(task.origem || { tipo: 'manual' }), subtarefaDe: task.id },
      pai: task.id,
    })
    dependenciasAnteriores.push(id)
  }
  return subtarefas
}

/**
 * Deduz dependências entre tasks de componentes diferentes.
 *
 * Regra: se uma task menciona um artefato de backend (endpoint, contrato,
 * campo, rota de API) e existe outra task que implementa o cliente/consumidor
 * desse artefato, a segunda depende da primeira. Errar aqui custa paralelismo;
 * errar na outra direção custa retrabalho. Por isso só marca dependência com
 * evidência textual forte, e sempre em silêncio.
 */
export function deduzirDependencias(tasks) {
  const padroes = {
    'portal-consome': /frontend|portal|tela|view|cliente|consum|consumer|chamada no front|exibir na tela/i,
    'backend-muda-contrato': /contrato|endpoint|nova rota|schema|migra|modelo prisma|tabela|campo novo|api/i,
    'chamados': /chamados|protocolo|sla|atendimento/i,
    'sce': /sce|equipamento|emprestimo|empréstimo|catalogo|catálogo|auditoria/i,
  }

  const novas = tasks.map((t) => ({ ...t, dependsOn: [...(t.dependsOn || [])] }))
  const raciocinios = []

  for (const consumidor of novas) {
    const textoCons = [consumidor.titulo, consumidor.descricao, ...(consumidor.criterios || [])].join(' ')
    if (!padroes['portal-consome'].test(textoCons)) continue

    for (const produtor of novas) {
      if (produtor.id === consumidor.id) continue
      if (consumidor.dependsOn.includes(produtor.id)) continue
      const textoProd = [produtor.titulo, produtor.descricao, ...(produtor.criterios || [])].join(' ')

      // Só vale se o produtor realmente mexe num backend.
      if (!padroes['backend-muda-contrato'].test(textoProd)) continue
      // Evitar dependência circular e ordem invertida por id.
      if (produtor.dependsOn.includes(consumidor.id)) continue

      // Evidência de que é o MESMO assunto, não só backend genérico.
      const evidencia = shared(assuntos(textoCons), assuntos(textoProd))
      if (!evidencia.length) continue

      consumidor.dependsOn.push(produtor.id)
      raciocinios.push({
        taskId: consumidor.id,
        dependeDe: produtor.id,
        motivo: `contrato em comum: ${evidencia.join(', ')}`,
        tipo: 'deduzida',
      })
    }
  }

  return { tasks: novas, raciocinios }
}

/** Palavras que identificam o "assunto" de uma tarefa, para casar com a outra. */
function assuntos(texto) {
  const alvo = texto.toLowerCase()
  const achados = []
  const candidatos = [
    'categoria', 'chamado', 'protocolo', 'equipamento', 'modelo', 'unidade', 'escola',
    'filial', 'tutor', 'tutorial', 'notificacao', 'notificação', 'formulario', 'formulário',
    'pergunta', 'usuario', 'usuário', 'permissao', 'permissão', 'escopo', 'feedback',
    'avaliacao', 'avaliação', 'auditoria', 'manutencao', 'manutenção', 'dvr', 'camera', 'câmera',
    'relatorio', 'relatório', 'dashboard', 'painel', 'estoque', 'emprestimo', 'empréstimo',
  ]
  for (const c of candidatos) if (alvo.includes(c)) achados.push(c)
  return new Set(achados)
}

function shared(a, b) {
  const out = []
  for (const x of a) if (b.has(x)) out.push(x)
  return out
}

/**
 * Detecta ciclo no grafo de dependências. Sem isso, duas tasks que se
 * declaram mutuamente dependentes travam o scheduler em silêncio.
 */
export function detectarCiclo(tasks) {
  const grafo = new Map(tasks.map((t) => [t.id, (t.dependsOn || []).filter((d) => tasks.some((x) => x.id === d))]))
  const estado = new Map()
  const pilha = []

  function visitar(id) {
    if (estado.get(id) === 'visitando') {
      const i = pilha.indexOf(id)
      return [...pilha.slice(i), id]
    }
    if (estado.get(id) === 'visitado') return null
    estado.set(id, 'visitando')
    pilha.push(id)
    for (const dep of grafo.get(id) || []) {
      const ciclo = visitar(dep)
      if (ciclo) return ciclo
    }
    pilha.pop()
    estado.set(id, 'visitado')
    return null
  }

  for (const t of tasks) {
    const c = visitar(t.id)
    if (c) return c
  }
  return null
}

/**
 * Ordenação topológica. É a ordem de integração e de desbloqueio: tudo que
 * depende de outra roda depois dela.
 */
export function ordenarTopologicamente(tasks) {
  const porId = new Map(tasks.map((t) => [t.id, t]))
  const grauEntrada = new Map(tasks.map((t) => [t.id, (t.dependsOn || []).filter((d) => porId.has(d)).length]))
  const dependents = new Map(tasks.map((t) => [t.id, []]))
  for (const t of tasks) {
    for (const d of t.dependsOn || []) {
      if (porId.has(d)) dependents.get(d).push(t.id)
    }
  }

  // Maior prioridade primeiro dentro do mesmo nível: respeita o que a pessoa
  // disse que é mais importante sem violar dependência.
  const prontas = tasks.filter((t) => grauEntrada.get(t.id) === 0)
  const ordem = []
  while (prontas.length) {
    const atual = prontas.shift()
    ordem.push(atual)
    for (const depId of dependents.get(atual.id) || []) {
      grauEntrada.set(depId, grauEntrada.get(depId) - 1)
      if (grauEntrada.get(depId) === 0) prontas.push(porId.get(depId))
    }
  }

  if (ordem.length !== tasks.length) {
    const faltando = tasks.filter((t) => !ordem.includes(t)).map((t) => t.id)
    throw new Error(`Ordenação impossível; fora do grafo (ciclo): ${faltando.join(', ')}`)
  }
  return ordem
}

/**
 * Conflito previsto: tasks que declaram/atingem os mesmos arquivos e não têm
 * relação de dependência entre si. É o aviso que evita dois agentes editando a
 * mesma tela ao mesmo tempo.
 *
 * Só considera dependência como EXCLUSÃO se for real (depender uma da outra
 * significa que a segunda nem existe ainda, então não há disputa).
 */
export function preverConflitos(tasks, { arquivosPorTask = {} } = {}) {
  const conflitos = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]
      const b = tasks[j]
      if (estaNaLinhaDoAnother(a, b)) continue

      const arquivosA = arquivosPorTask[a.id] || a.arquivosAlvo || []
      const arquivosB = arquivosPorTask[b.id] || b.arquivosAlvo || []
      // Usa o predicado `colidem`, não interseção exata: um escopo declarado
      // como diretório precisa disputar com um arquivo dentro dele.
      const inter = intersectamColidindo(arquivosA, arquivosB)
      if (inter.length) {
        conflitos.push({
          a: a.id,
          b: b.id,
          arquivos: inter,
          severidade: inter.some((f) => /\.(ts|vue|js|mjs)$/.test(f)) ? 'alta' : 'media',
          resolucao: `Serializar: ${a.id} e depois ${b.id}, ou declarar dependência entre elas.`,
        })
      }
    }
  }
  return conflitos
}

function estaNaLinhaDoAnother(a, b) {
  const dep = (t, o) => (t.dependsOn || []).includes(o.id)
  return dep(a, b) || dep(b, a)
}

/** Interseção que respeita diretório: `src/views/` disputa com `src/views/A.vue`. */
function intersectamColidindo(a, b) {
  const out = []
  for (const x of a || []) {
    for (const y of b || []) {
      if (colidem(x, y)) {
        out.push(x)
        break
      }
    }
  }
  return [...new Set(out)].sort()
}

/**
 * Dois arquivos colidem se forem iguais OU se um estiver dentro de um diretório
 * do outro. Aceita tanto `src/views/` quanto `DIRETORIO:src/views`.
 */
export function colidem(a, b) {
  if (a === b) return true
  const norm = (x) => {
    const semPrefixo = x.startsWith('DIRETORIO:') ? x.slice('DIRETORIO:'.length) : x
    return semPrefixo.replace(/\/+$/, '') + '/'
  }
  const na = norm(a)
  const nb = norm(b)
  return na.startsWith(nb) || nb.startsWith(na)
}

/**
 * Risco da tarefa. Não é decoração: risco alto recebe mais scrutiny na revisão
 * e entra no relatório final para a pessoa olhar com mais cuidado.
 */
export function avaliarRisco(task) {
  // Atravessar a fronteira entre componentes é, por si só, risco alto: em
  // `chamados`/`sce` isso significa outro repositório, outro branch, outro
  // ciclo de release, e o gate de um não cobre o outro. Some 2 pontos, mas o
  // veredito sobe direto para alto.
  const cruzaComponentes = (task.componentes || []).length > 1
  if (cruzaComponentes) {
    return 'alto'
  }

  // Superfície de segurança: autenticação, token, senha, permissão, SSO. Mexer
  // aqui é sempre alto, mesmo em task pequena — é a área onde uma alteração
  // silenciosamente errada derruba o acesso de todo mundo.
  const texto = [task.titulo, task.descricao, ...(task.criterios || [])].join(' ').toLowerCase()
  if (/autentic|\btoken\b|senha|permiss|\bsso\b|credencial|sess[aã]o|login|logout/.test(texto)) {
    return 'alto'
  }

  let pontos = 0
  if (/contrato|schema|migra|prisma|tabela|autentic|token|senha|permiss|seguran/.test(texto)) pontos += 2
  if (/refator|reescrev|reestrutur|migrar tudo|portar/.test(texto)) pontos += 2
  if (task.arquivosAlvo?.length > 8) pontos += 1
  if ((task.dependsOn || []).length > 2) pontos += 1
  // Operação destrutiva. Vale +2, e normalmente soma com a regra de schema/
  // migração acima — "remover tabela" acerta as duas e sobe para alto.
  if (/delet|remov|drop|apagar|limpa/.test(texto)) pontos += 2

  if (pontos >= 4) return 'alto'
  if (pontos >= 2) return 'medio'
  return 'baixo'
}