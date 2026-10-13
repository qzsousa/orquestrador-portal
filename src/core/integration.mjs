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
import { prepararAmbiente, limparAmbiente, rodarGate } from './review.mjs'

/**
 * Prepara o worktree de integração. Base = branch principal no momento da
 * integração (não o base da task): é contra a main que a mudança precisa provar
 * que funciona.
 *
 * O ambiente é o mesmo que o do runner, pelos mesmos motivos: dependência
 * `file:` que aponta para a árvore base faria o gate ler o contrato de outra
 * árvore, e era o que fazia a integração passar com um `dist` velho.
 */
export function prepararIntegracao({ cfg, repo, nome = 'integracao', log = () => {} }) {
  const dir = join(cfg.worktreesDir, '__integracao__', nome)
  const branch = `${cfg.integrationBranchPrefix}/${nome}`

  // Idempotência: reexecutar a integração NÃO pode destruir o resultado da
  // anterior. A branch é o registro do que já foi integrado; recriá-la do zero a
  // cada `orq integrate` fazia o mesmo lote ser integrado várias vezes, com um
  // merge commit vazio por task a cada rodada. Então reconecta nela quando ela
  // existe, e só cria da main quando não existe — e nesse caso, por definição,
  // não há resultado anterior para perder.
  const reaproveitada = git.branchExists(branch, repo)
  if (existsSync(dir)) {
    git.removerWorktree(repo, dir, { forcar: true })
    // Sobra de uma remoção anterior: o git limpa o conteúdo mas devolve a pasta,
    // e `worktree remove` não a remove porque ela não está mais na lista dele.
    // Sem esta linha, a integração seguinte morre em "diretório já existe" — e a
    // mensagem aponta para o diretório, não para o worktree órfão que o causou.
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      git.run(['worktree', 'prune'], { cwd: repo })
    }
  }

  const mainBranch = git.branchAtual(repo)
  const wt = git.criarWorktree({ repo, dir, branch, baseRef: mainBranch, reaproveitarBranch: true })
  const ambiente = prepararAmbiente(dir, repo, { log })

  // `base` é o ponto de DIVERGÊNCIA com a main, não o commit de criação. Com a
  // branch reaproveitada, o commit de criação é a própria branch — usá-lo como
  // base faria o relatório de commits mostrar zero, sempre.
  const baseSha = reaproveitada
    ? git.tentar(['merge-base', mainBranch, branch], { cwd: repo }) || wt.baseSha
    : wt.baseSha

  return { ...wt, baseSha, branchPrincipal: mainBranch, reaproveitada, ambiente }
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
  try {
    integracao = prepararIntegracao({ cfg, repo, nome })
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
  const gates = gatesDasTasks(cfg, ordenadas)
  let gatesOk = true
  for (const g of gates) {
    const cwd = g.cwd ? join(integracao.worktree, g.cwd) : integracao.worktree
    if (!existsSync(join(cwd, 'package.json'))) {
      relatorio.avisos.push(`Gate "${g.nome}" pulado: ${join(g.cwd || '.', 'package.json')} não existe`)
      continue
    }
    const res = rodarGate({ gate: g, cwd })
    relatorio.gates.push({ ...res, taskId: 'integracao' })
    if (!res.ok) {
      gatesOk = false
      relatorio.bloqueios.push(
        `Gate "${g.nome}" falhou no conjunto integrado (exit ${res.exitCode}). ` +
          `Últimas linhas: ${(res.stderr || res.stdout).trim().split('\n').slice(-4).join(' | ')}`,
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
 */
export function aplicarNaPrincipal({ repo, branchIntegracao, baseSha, branchPrincipal }) {
  // Merge pela BRANCH, e não pelo `baseSha`: com a integração idempotente a
  // branch pode ter sido reaproveitada de uma rodada anterior, e o `baseSha` é o
  // ponto de divergência com a main — trazer ele para a main seria um no-op que
  // "aplica" sem aplicar nada e ainda assim marca as tasks como concluídas.
  const ref = branchIntegracao || baseSha
  const antes = git.revParse(branchPrincipal, repo)
  git.run(['merge', '--ff-only', ref], { cwd: repo })
  return { branchPrincipal, antes, depois: git.revParse('HEAD', repo) }
}

/**
 * Limpa worktrees de integração que não estão mais em uso.
 *
 * Devolve o que NÃO conseguiu limpar. A versão anterior devolvia `false` e
 * engolia a causa: uma junction que sobrou faz o próximo `orq integrate` recusar
 * o diretório, e a mensagem que aparecia falava do diretório, não da junction.
 */
export function limparIntegracao({ repo, dir, log = () => {} }) {
  if (!existsSync(dir)) return { removido: false, falhas: [] }
  const falhas = []
  let removido = false
  try {
    git.removerWorktree(repo, dir, { forcar: true })
    // O `git worktree remove` limpa o conteúdo e devolve a pasta vazia. Sem
    // este passo, `existsSync` continua respondendo "sim" e a próxima chamada
    // diria "removido" de novo, sem ter removido nada.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    git.run(['worktree', 'prune'], { cwd: repo })
    removido = true
  } catch (err) {
    falhas.push(`worktree: ${err.message}`)
  }
  const ambiente = limparAmbiente(dir, repo, { log })
  falhas.push(...ambiente.falhas.map((f) => `ambiente: ${f}`))
  return { removido, falhas }
}