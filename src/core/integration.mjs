/**
 * Integração: juntar as branches aprovadas sem tocar na branch principal.
 *
 * Fluxo, e o porquê de cada etapa:
 *   1. worktree próprio de integração  -> a main nunca é campo de teste
 *   2. merge em ordem topológica      -> dependência resolvida antes da independente
 *   3. gate a cada merge              -> falha no meio para aqui, não na main
 *   4. relatório + PARADA             -> merge na main é decisão do responsável
 *
 * O passo 4 é o mais importante deste arquivo. A integração vai até o ponto em
 * que a mudança está provada e pronta, e para. Quem decide aplicar na main é a
 * pessoa, com `orq integrate --aplicar`.
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as git from './git.mjs'
import { ordemDeIntegracao, conflitosEntreBranches } from './scheduler.mjs'
import { prepararAmbiente, limparAmbiente, rodarGate, subdiretoriosDeGate, diretoriosNodeModules } from './review.mjs'

/**
 * Prepara o worktree de integração. Base = branch principal no momento da
 * integração (não o base da task): é contra a main que a mudança precisa provar
 * que funciona.
 *
 * O ambiente é o mesmo que o do runner, pelos mesmos motivos: dependência
 * `file:` que aponta para a árvore base faria o gate ler o contrato de outra
 * árvore, e era o que fazia a integração passar com um `dist` velho.
 */
export function prepararIntegracao({ cfg, repo, nome = 'integracao', log = () => {}, gates = [] }) {
  const dir = join(cfg.worktreesDir, '__integracao__', nome)
  const branch = `${cfg.integrationBranchPrefix}/${nome}`

  // Residuo da rodada anterior. O worktree carrega junctions de node_modules,
  // que seguram o diretorio e fazem removerWorktree falhar; o git tambem recusa
  // apagar a branch enquanto o worktree existir. Deixar esse lixo bloqueava toda
  // integracao seguinte com "Diretorio de worktree ja existe".
  if (existsSync(dir)) {
    for (const alvo of diretoriosNodeModules(dir)) {
      try {
        removerLinkSeguro(join(dir, alvo))
      } catch {}
    }
    try {
      git.removerWorktree(repo, dir, { forcar: true })
    } catch {}
    // O `git worktree remove` limpa o conteudo e devolve a pasta vazia.
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  // Registro de worktree cujo diretorio ja nao existe (interrupcao, limpeza
  // manual, queda) continua no git e aparece como "prunable". Enquanto ele
  // estiver la, o git recusa `branch -D` dizendo que a branch esta em uso -- e a
  // integracao seguinte falha com "Branch ja existe" sem que exista worktree
  // nenhum. prune remove so as entradas cujo diretorio sumiu.
  try {
    git.run(['worktree', 'prune'], { cwd: repo })
  } catch {}

  // Idempotencia: a branch de integracao e o REGISTRO do que ja entrou.
  //
  // Antes ela era apagada e reconstruida da principal a cada rodada. Isso
  // resolvia o "Branch ja existe", mas quebrava o relatorio: reexecutar
  // reintegrava o lote inteiro e criava um merge commit vazio por task, e o
  // relatorio dizia "N tasks integradas" com o diff de sempre. Reconectar nela
  // e o que torna a segunda rodada um no-op honesto.
  //
  // Se ninguem estiver segurando a branch e ela nao servir (base inexistente),
  // `criarWorktree` deixa claro o que aconteceu em vez deFalhar calado.
  const mainBranch = git.branchAtual(repo)
  const wt = git.criarWorktree({ repo, dir, branch, baseRef: mainBranch, reaproveitarBranch: true })

  // Os gates rodam nos mesmos cwds que rodam na task, e com a mesma
  // preparacao de ambiente: sem o node_modules destes subdiretorios o gate
  // falha com "tsc nao e reconhecido", o que parece falha do codigo integrado
  // quando e o worktree sem dependencia.
  const ambiente = prepararAmbiente(dir, repo, { subdirs: subdiretoriosDeGate(gates), log })

  // `base` e o ponto de DIVERGENCIA com a main, nao o commit de criacao. Com a
  // branch reaproveitada, o commit de criacao e a propria branch -- usa-lo
  // como base faria o relatorio de commits mostrar zero, sempre.
  const reaproveitada = Boolean(wt.reaproveitada)
  const baseSha = reaproveitada
    ? git.tentar(['merge-base', mainBranch, branch], { cwd: repo }) || wt.baseSha
    : wt.baseSha

  return { ...wt, baseSha, branchPrincipal: mainBranch, reaproveitada, ambiente }
}

/** Remove um `node_modules` do worktree sem apagar o conteudo do destino. */
function removerLinkSeguro(dir) {
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Integra um conjunto de tasks aprovadas. Devolve relatório detalhado.
 * Não merge na branch principal em hipótese alguma — só na branch de integração.
 */
export function integrar({ cfg, tasks, repo, nome = 'integracao' }) {
  const relatorio = {
    inicio: new Date().toISOString(),
    branchIntegracao: null,
    base: null,
    ordem: [],
    resultados: [],
    conflitos: [],
    gates: [],
    avisos: [],
    aprovado: false,
    bloqueios: [],
  }

  if (!tasks.length) {
    relatorio.bloqueios.push('Nenhuma task aprovada para integrar.')
    return relatorio
  }

  // Conflitos de arquivo entre as branches, ANTES de qualquer merge. Descobrir
  // isso depois do primeiro merge significa desfazer merge para investigate.
  const branches = tasks.map((t) => ({
    taskId: t.id,
    branch: t.branch,
    arquivos: arquivosReaisDaBranch({ repo, branch: t.branch, baseSha: t.baseSha }),
    dependeDe: t.dependsOn || [],
  }))
  relatorio.conflitos = conflitosEntreBranches({ branches })

  const ordenadas = ordemDeIntegracao(tasks)
  relatorio.ordem = ordenadas.map((t) => t.id)

  let integracao
  // Os gates são conhecidos antes do worktree existir: o ambiente precisa ser
  // preparado nos mesmos subdiretórios onde os gates vão rodar.
  const gates = gatesDasTasks(cfg, ordenadas)
  try {
    integracao = prepararIntegracao({ cfg, repo, nome, gates })
    relatorio.branchIntegracao = integracao.branch
    relatorio.base = integracao.baseSha
  } catch (err) {
    relatorio.bloqueios.push(`Não foi possível criar o worktree de integração: ${err.message}`)
    return relatorio
  }

  // Fase 1 — merge de cada branch, em ordem topológica.
  //
  // NÃO se roda gate aqui. Um gate de repositório (build, suíte completa)
  // valida o CONJUNTO integrado: rodar depois da primeira de três branches
  // falha por definição, porque as outras duas ainda não entraram. Validar no
  // meio do caminho reprovaria toda integração que tenha mais de uma task.
  for (const task of ordenadas) {
    const r = { taskId: task.id, branch: task.branch, ok: false, conflito: null, erro: null, jaIntegrada: false }

    // Idempotência: uma branch cujos commits já são ancestrais do HEAD da
    // integração já entrou. Sem esta checagem, a segunda rodada de `orq
    // integrate` criaria um merge vazio por task e o relatório mostraria "3
    // tasks integradas" para o mesmo lote, com o diff de sempre.
    //
    // O HEAD é o DO WORKTREE DE INTEGRAÇÃO. Comparar com o `HEAD` do repo seria
    // comparar com a main, e nenhuma branch de task é ancestral da main — a
    // checagem nunca passaria e a idempotência não existiria.
    if (git.isAncestor(integracao.worktree, task.branch, 'HEAD')) {
      r.ok = true
      r.jaIntegrada = true
      relatorio.resultados.push(r)
      continue
    }

    try {
      // --no-commit + --no-ff: se houver conflito, NADA é gravado e o worktree
      // volta ao estado anterior. Merge atômico por task.
      git.run(['merge', '--no-ff', '--no-commit', task.branch], { cwd: integracao.worktree })

      const emConflito = arquivosEmConflitoState(integracao.worktree)
      if (emConflito.length) {
        git.run(['merge', '--abort'], { cwd: integracao.worktree })
        r.conflito = emConflito
        r.erro = `Conflito em: ${emConflito.join(', ')}`
        relatorio.resultados.push(r)
        relatorio.bloqueios.push(`${task.id} conflita com o que já foi integrado: ${emConflito.join(', ')}`)
        break
      }

      // Merge que não mudou nada (branch já contida no HEAD por outro caminho)
      // não gera commit: um merge commit vazio polui o histórico da main com um
      // registro que não corresponde a trabalho nenhum.
      if (!git.arvoreLimpa(integracao.worktree)) {
        git.run(['commit', '-m', `merge(${task.id}): ${task.titulo}`], { cwd: integracao.worktree })
      }
      r.ok = true
    } catch (err) {
      // Merge já committed ou abortado: garante estado limpo para o próximo.
      try {
        if (git.tentar(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: integracao.worktree }) !== '') {
          git.run(['merge', '--abort'], { cwd: integracao.worktree })
        }
      } catch {}
      r.erro = err.message
      relatorio.bloqueios.push(`${task.id} não pôde ser integrada: ${err.message}`)
    }
    relatorio.resultados.push(r)
  }

  // Fase 2 — valida o conjunto integrado, uma vez, sobre a árvore final.
  let gatesOk = true

  // Gates de preparação rodam ANTES dos que verificam. O caso é o Prisma: o
  // client gerado fica dentro de node_modules, que é compartilhado por junction
  // com o repo base. Se o gate verificar antes de gerar, ele checa o código
  // novo contra o client do schema antigo e acusa erro de tipo que não existe
  // — falha de ambiente vestida de falha de código. O próprio projeto já
  // resolve isso no Dockerfile e no render.yaml ("npx prisma generate && npm
  // run build"); o gate só estava fazendo menos que o build de produção.
  const preparacoes = gates.filter((g) => g.preparar)
  const verificacoes = gates.filter((g) => !g.preparar)

  for (const g of preparacoes) {
    const cwd = g.cwd ? join(integracao.worktree, g.cwd) : integracao.worktree
    if (!existsSync(join(cwd, 'package.json'))) {
      relatorio.avisos.push(`Preparação "${g.nome}" pulada: ${join(g.cwd || '.', 'package.json')} não existe`)
      continue
    }
    const res = rodarGate({ gate: g, cwd })
    relatorio.gates.push({ ...res, taskId: 'integracao', fase: 'preparar' })
    if (!res.ok) {
      gatesOk = false
      relatorio.bloqueios.push(
        `Preparação "${g.nome}" falhou (exit ${res.exitCode}). ` +
          `Últimas linhas: ${(res.stderr || res.stdout).trim().split('\n').slice(-4).join(' | ')}`,
      )
    }
  }

  for (const g of verificacoes) {
    const cwd = g.cwd ? join(integracao.worktree, g.cwd) : integracao.worktree
    if (!existsSync(join(cwd, 'package.json'))) {
      relatorio.avisos.push(`Gate "${g.nome}" pulado: ${join(g.cwd || '.', 'package.json')} não existe`)
      continue
    }
    const res = rodarGate({ gate: g, cwd })
    relatorio.gates.push({ ...res, taskId: 'integracao', fase: 'verificar' })
    if (!res.ok) {
      gatesOk = false
      relatorio.bloqueios.push(
        `Gate "${g.nome}" falhou no conjunto integrado (exit ${res.exitCode}). ` +
          `Últimas linhas: ${(res.stderr || res.stdout).trim().split('\n').slice(-4).join(' | ')}`,
      )
    }
  }

  // O client gerado é compartilhado com o repo base (junction). Gerar no
  // worktree de integração deixa o repo base com um client de outro schema.
  // Reexecutar a preparação no repo base devolve ele ao estado coerente com a
  // main — que é o que o próximo typecheck dele espera.
  for (const g of preparacoes) {
    const cwdBase = g.cwd ? join(repo, g.cwd) : repo
    if (!existsSync(join(cwdBase, 'package.json'))) continue
    const res = rodarGate({ gate: g, cwd: cwdBase })
    relatorio.gates.push({ ...res, taskId: 'repo-base', fase: 'restaurar-base' })
    if (!res.ok) {
      relatorio.avisos.push(
        `Não foi possível restaurar o ambiente do repo base com "${g.nome}" ` +
          `(exit ${res.exitCode}). Rode o comando manualmente antes de usar a main.`,
      )
    }
  }

  relatorio.aprovado = gatesOk && relatorio.bloqueios.length === 0 && relatorio.resultados.every((r) => r.ok)
  relatorio.fim = new Date().toISOString()
  relatorio.integracao = integracao
  relatorio.commits = git.commitsDesde(integracao.worktree, integracao.baseSha)
  return relatorio
}

/**
 * Arquivos de verdade de uma branch: os que ela alterou em relação ao base.
 * Preferimos isto a `arquivosAlvo` declarado, porque o que o agente FEZ é o que
 * conflita — não o que ele disse que ia fazer.
 */
function arquivosReaisDaBranch({ repo, branch, baseSha }) {
  if (!branch) return []
  try {
    const mergeBase = git.tentar(['merge-base', mainRef(repo), branch], { cwd: repo }) || baseSha
    return git
      .tentar(['diff', '--name-only', `${mergeBase}..${branch}`], { cwd: repo })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return []
  }
}

function mainRef(repo) {
  const atual = git.branchAtual(repo)
  return atual === 'HEAD' ? 'main' : atual
}

/** Arquivos em conflito de merge no worktree (UNMERGED). */
function arquivosEmConflitoState(worktree) {
  const out = git.tentar(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree })
  return out ? out.split(/\r?\n/).filter(Boolean) : []
}

/** Gates do conjunto integrado, sem repetir o mesmo gate duas vezes. */
function gatesDasTasks(cfg, tasks) {
  const vistos = new Set()
  const gates = []
  for (const task of tasks) {
    for (const c of task.componentes?.length ? task.componentes : ['portal']) {
      for (const g of cfg.componentes[c]?.gates || []) {
        const chave = `${c}:${g.nome}:${g.cwd || '.'}`
        if (vistos.has(chave)) continue
        vistos.add(chave)
        gates.push(g)
      }
    }
  }
  return gates
}

/**
 * Aplicar de fato na branch principal.
 *
 * Só chega aqui por `orq integrate --aplicar`, que exige a flag explícita. E
 * ainda assim é fast-forward apenas: se a branch de integração tiver overtaken
 * a main de forma não-linear, o comando falha em vez de criar um merge
 * commit surpresa. Nenhum push é feito em nenhum momento.
 *
 * `commitIntegracao` é o HEAD do worktree de integração — o RESULTADO. Passar o
 * base (de onde a integração partiu) aqui faz o fast-forward não mover nada e
 * ainda reportar sucesso: `main: 1c78db2 → 1c78db2`. Foi o que aconteceu.
 */
export function aplicarNaPrincipal({ repo, commitIntegracao, branchIntegracao, baseSha, branchPrincipal }) {
  const antes = git.revParse(branchPrincipal, repo)

  // A ref é a BRANCH de integração (ou o commit dela), nunca o `baseSha`: o
  // `baseSha` é o ponto de divergência com a principal, e trazer ele seria um
  // fast-forward que não move nada — e ainda assim marcaria as tasks como
  // concluídas. Foi exatamente o que aconteceu: `main: 1c78db2 → 1c78db2`.
  const ref = commitIntegracao || branchIntegracao || baseSha

  if (!ref || ref === antes) {
    throw new Error(
      `Nada a aplicar: a integração não produziu commit novo ` +
        `(branch principal e integração estão em ${antes.slice(0, 7)}).`,
    )
  }

  git.run(['merge', '--ff-only', ref], { cwd: repo })
  const depois = git.revParse('HEAD', repo)

  if (depois === antes) {
    throw new Error(
      `O fast-forward não moveu ${branchPrincipal} (continua em ${antes.slice(0, 7)}). ` +
        `A integração aponta para ${ref.slice(0, 7)}, que não é descendente da principal.`,
    )
  }

  return { branchPrincipal, antes, depois }
}

/**
 * Limpa worktrees de integração que não estão mais em uso.
 *
 * Devolve o que NÃO conseguiu limpar, em vez de devolver `false`: um link que
 * sobrou faz o próximo `orq integrate` recusar o diretório, e a mensagem que
 * aparecia falava do diretório, não do link — mandando procurar a causa no lugar
 * errado.
 */
export function limparIntegracao({ repo, dir, log = () => {}, gates = [] }) {
  if (!existsSync(dir)) return { removido: false, falhas: [] }
  const falhas = []
  let removido = false
  try {
    // O ambiente primeiro: a junction segura o diretório e faz o
    // `git worktree remove` falhar.
    const ambiente = limparAmbiente(dir, repo, { log })
    falhas.push(...(ambiente.falhas || []).map((f) => `ambiente: ${f}`))

    git.removerWorktree(repo, dir, { forcar: true })
    // O `git worktree remove` limpa o conteúdo e devolve a pasta vazia. Sem
    // este passo, `existsSync` continua respondendo "sim" e a chamada seguinte
    // diria "removido" de novo, sem ter removido nada.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    git.run(['worktree', 'prune'], { cwd: repo })
    removido = true
  } catch (err) {
    falhas.push(`worktree: ${err.message}`)
  }
  return { removido, falhas, gates }
}
