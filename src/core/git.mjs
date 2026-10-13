/**
 * Camada de Git do orquestrador.
 *
 * Regra que dá nome ao arquivo inteiro: um agente NUNCA roda `git push` e
 * NUNCA commita na main. Este módulo expõe deliberadamente as operações de
 * escrita minima para trabalhar, e `assertWriteOperation` barra o resto.
 *
 * Todo comando passa por array de argumentos (execFileSync), nunca string de
 * shell: título de tarefa vira nome de branch, e título de tarefa vem do
 * Trello. Concatenar em shell seria_remote code execution.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Operações que este módulo se recusa a executar. */
const PROIBIDAS = new Set([
  'push',
  'remote update',
  'reset --hard',
  'clean -fd',
  'rebase',
  'filter-branch',
  'checkout -f',
  'branch -D',
])

export class GitError extends Error {}

/**
 * Executa git. `allowDestructive` e o que impede um `push` acidental vindo de
 * código futuro — o default é negar, e quem precisar libera explicitamente.
 *
 * O verbo procurado é o primeiro argumento que NÃO seja uma opção. Sem isso,
 * `git --no-pager push` passava direto pela barreira.
 */
export function run(args, { cwd, allowDestructive = false } = {}) {
  // O verbo é o primeiro argumento que não é opção: é o que pega
  // `git --no-pager push`. A assinatura crua continua sendo conferida para
  // pegar `git branch -D x`, cuja parte perigosa é a opção depois do verbo.
  const semOpcoes = args.filter((a) => !String(a).startsWith('-'))
  const verb = String(semOpcoes[0] ?? args[0] ?? '')
  const assinaturaCrua = args.slice(0, 2).join(' ')
  const perigoso =
    PROIBIDAS.has(verb) ||
    PROIBIDAS.has(assinaturaCrua) ||
    semOpcoes.slice(0, 2).join(' ') === 'remote update'

  if (!allowDestructive && perigoso) {
    throw new GitError(
      `Operação de Git bloqueada pelo orquestrador: \`git ${args.join(' ')}\`. ` +
        `Push, reset --hard, rebase e branch -D exigem autorização explícita do responsável.`,
    )
  }
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '')
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim()
    throw new GitError(`git ${args.join(' ')} falhou${stderr ? `: ${stderr}` : `: ${err.message}`}`)
  }
}

/** Igual a run(), mas devolve '' em vez de lançar. Para consultas opcionais. */
export function tentar(args, opts = {}) {
  try {
    return run(args, opts)
  } catch {
    return ''
  }
}

/**
 * O git no Windows devolve caminhos com `/` mesmo quando o resto do sistema
 * usa `\`. Misturar os dois quebra comparações de caminho (`includes`,
 * `===`) e faz o worktree parecer diferente de si mesmo. Normalizamos na
 * entrada para que todo o resto do orquestrador conviva com um formato só.
 */
export function normalizarCaminho(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  return process.platform === 'win32' ? s.replace(/\//g, '\\') : s
}

export function isRepo(dir) {
  if (!dir || !existsSync(dir)) return false
  return tentar(['rev-parse', '--is-inside-work-tree'], { cwd: dir }) === 'true'
}

/** Raiz do repositório a partir de qualquer subdiretório. */
export function repoTop(dir) {
  return normalizarCaminho(run(['rev-parse', '--show-toplevel'], { cwd: dir }).trim())
}

/**
 * Em worktree, `--show-toplevel` devolve o worktree e o repositório principal
 * fica em `git rev-parse --path-format=absolute --git-common-dir`. Precisamos
 * do comum para saber qual repo dona a branch — é o que permite mapear uma
 * tarefa de `sce/` para o repo do SCE e não para o portal.
 */
export function commonDir(dir) {
  const p = normalizarCaminho(
    run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir }).trim(),
  )
  return p.replace(/\/\.git$/, '').replace(/\\\.git$/, '')
}

export function branchAtual(dir) {
  return run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).trim()
}

export function revParse(ref, cwd) {
  const r = tentar(['rev-parse', ref], { cwd })
  if (!r) throw new GitError(`Ref não encontrada: ${ref}`)
  return r.trim()
}

/**
 * Verdadeiro se o comando saiu com código 0.
 *
 * Necessário porque `git show-ref --quiet` e `git merge-base --is-ancestor`
 * saem com 0 sem imprimir nada quando a resposta é "sim". Checar o output
 * textual trataria "existe" como "não existe".
 */
export function saiuComZero(args, opts = {}) {
  try {
    execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    return true
  } catch {
    return false
  }
}

export function branchExists(branch, cwd) {
  return saiuComZero(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
}

export function branchRemotoExiste(branch, cwd) {
  return saiuComZero(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd })
}

/**
 * Lista os worktrees do repo.
 *
 * O git imprime os caminhos com `/` mesmo no Windows, então tudo é normalizado
 * aqui. Sem isso, `worktreeExiste` compara `C:/x` com `C:\x` e diz que um
 * worktree que existe não existe — o que faria a limpeza pular por cima dele.
 */
export function worktreeList(repo) {
  const out = run(['worktree', 'list', '--porcelain'], { cwd: repo })
  const lista = []
  let atual = null
  for (const linha of out.split(/\r?\n/)) {
    if (linha.startsWith('worktree ')) {
      if (atual) lista.push(atual)
      atual = { path: normalizarCaminho(linha.slice('worktree '.length)) }
    } else if (linha.startsWith('HEAD ')) {
      if (atual) atual.head = linha.slice('HEAD '.length)
    } else if (linha.startsWith('branch ')) {
      if (atual) atual.branch = linha.slice('branch '.length).replace('refs/heads/', '')
    } else if (linha === 'detached') {
      if (atual) atual.detached = true
    }
  }
  if (atual) lista.push(atual)
  return lista
}

export function worktreeExiste(path) {
  const alvo = normalizarCaminho(path)
  return worktreeListEverywhere(alvo).some((w) => normalizarCaminho(w.path) === alvo)
}

function worktreeListEverywhere(path) {
  try {
    return run(['worktree', 'list', '--porcelain'], { cwd: path })
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => ({ path: l.slice('worktree '.length) }))
  } catch {
    return []
  }
}

/**
 * Cria worktree + branch de uma task, sempre a partir de um commit pinado.
 *
 * Fixar o base é o que torna a integração previsível: se a main andar durante
 * a execução, a task não muda de lugar embaixo dos pés, e o orquestrador
 * decide explicitamente quando reprocessar.
 */
export function criarWorktree({ repo, dir, branch, baseRef = 'HEAD', reaproveitarBranch = false }) {
  if (existsSync(dir)) {
    throw new GitError(`Diretório de worktree já existe: ${dir}`)
  }
  const branchJaExiste = branchExists(branch, repo)
  if (branchJaExiste && !reaproveitarBranch) {
    throw new GitError(`Branch já existe: ${branch}`)
  }
  if (branchJaExiste) {
    // Sem `-b`: o git apenas reconecta a worktree na branch existente.
    run(['worktree', 'add', dir, branch], { cwd: repo })
    return { branch, worktree: dir, baseSha: revParse(branch, repo), repo, reaproveitada: true }
  }
  const baseSha = revParse(baseRef, repo)
  run(['worktree', 'add', '-b', branch, dir, baseSha], { cwd: repo })
  return { branch, worktree: dir, baseSha, repo, reaproveitada: false }
}

export function removerWorktree(repo, dir, { forcar = false } = {}) {
  if (!worktreeExiste(dir)) return false
  run(['worktree', 'remove', dir, ...(forcar ? ['--force'] : [])], { cwd: repo })
  return true
}

export function removerWorktreePorCaminho(dir, { forcar = false } = {}) {
  const repo = commonDir(dir)
  return removerWorktree(repo, dir, { forcar })
}

/** Arquivos já commitados na branch em relação ao base. */
export function arquivosCommitados(dir, baseSha) {
  const out = tentar(['diff', '--name-only', `${baseSha}..HEAD`], { cwd: dir })
  return out ? out.split(/\r?\n/).filter(Boolean) : []
}

/** Alterações não commitadas: staged + unstaged + untracked. */
export function arquivosNaoCommitados(dir) {
  const out = tentar(['status', '--porcelain', '--untracked-files=all'], { cwd: dir })
  if (!out) return []
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1'))
}

/**
 * Tudo que a task mexeu: commitado + sujo. É o dado que alimenta a detecção de
 * conflito — por isso inclui o não commitado, senão dois agentes poderiam
 * "esbarrar" em dirty state sem o orquestrador perceber.
 */
export function arquivosAfetados(dir, baseSha) {
  return [...new Set([...arquivosCommitados(dir, baseSha), ...arquivosNaoCommitados(dir)])].sort()
}

export function arvoreLimpa(dir) {
  return tentar(['status', '--porcelain'], { cwd: dir }) === ''
}

export function statusPorArquivo(dir) {
  const out = tentar(['status', '--porcelain', '--untracked-files=all'], { cwd: dir })
  if (!out) return []
  return out.split(/\r?\n/).filter(Boolean).map((l) => ({
    codigo: l.slice(0, 2).trim(),
    arquivo: l.slice(3).trim(),
  }))
}

/**
 * Commita tudo que o agente deixou. Aceita mensagem e devolve o sha.
 * `stageAll` é true porque o agente pode ter criado arquivo novo.
 */
export function commitar(dir, mensagem, { stageAll = true } = {}) {
  if (stageAll) run(['add', '-A'], { cwd: dir })
  const status = tentar(['status', '--porcelain'], { cwd: dir })
  if (status === '') return null
  run(['commit', '-m', mensagem], { cwd: dir })
  return revParse('HEAD', dir)
}

export function commitsDesde(dir, baseSha) {
  const out = tentar(['log', '--format=%H%x1f%s', `${baseSha}..HEAD`], { cwd: dir })
  if (!out) return []
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, ...resto] = l.split('\x1f')
      return { sha: sha.trim(), mensagem: resto.join('\x1f').trim() }
    })
}

export function diffEstatistico(dir, baseSha) {
  const out = tentar(['diff', '--stat', `${baseSha}..HEAD`], { cwd: dir })
  return out || ''
}

/**
 * Simula o merge sem tocar em nada. É o que permite dizer "esta task conflita
 * com a main" ANTES de tentar integrar, e o que detecta conflito entre duas
 * tasks que tocaram o mesmo arquivo.
 *
 * `git merge-tree --write-tree` imprime o relatório de conflito no STDOUT, não
 * no stderr — por isso os dois fluxos são lidos. Confundir os dois dá "não há
 * conflito" quando há, que é a falha mais cara possível nesta função.
 */
export function testariaConflitar({ repo, baseSha, ref }) {
  try {
    const r = spawnSyncGit(['merge-tree', '--write-tree', baseSha, ref], repo)
    if (r.status === 0) return false
    const texto = `${r.stdout || ''}\n${r.stderr || ''}`
    return /conflict|CONFLICT|already exists|Automatic merge failed/i.test(texto)
  } catch {
    return false
  }
}

/** merge-tree precisa dos dois fluxos; execFileSync só devolvia stderr. */
function spawnSyncGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

/** Verifica se `ref` é ancestral de `other` (ou o próprio). */
export function isAncestor(repo, ref, other) {
  return saiuComZero(['merge-base', '--is-ancestor', ref, other], { cwd: repo })
}

export function listarBranches(repo) {
  const out = run(['branch', '--format=%(refname:short)%09%(objectname:short)'], { cwd: repo })
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split('\t')
      return { name, sha }
    })
}

/** Existe remote? Usado para avisar que existe integração pendente de push. */
export function temRemote(repo) {
  return tentar(['remote'], { cwd: repo }) !== ''
}

/**
 * Intersection entre conjuntos de arquivos. O core da detecção de conflito:
 * dois agentes que editaram o mesmo arquivo não podem rodar em paralelo.
 */
export function arquivosEmConflito(conjuntoA, conjuntoB) {
  const a = new Set(conjuntoA || [])
  const b = new Set(conjuntoB || [])
  const inter = []
  for (const f of a) if (b.has(f)) inter.push(f)
  return inter.sort()
}

/**
 * Deriva branch/worktree válidos de um id e slug. Slug vem de texto livre
 * (Trello), então é normalizado: só [a-z0-9-], sem acento, sem barra — barra
 * criaria branch aninhada e quebraria o rastreio por prefixo.
 */
export function branchParaTask(id, titulo, prefixo = 'orq') {
  const slug = String(titulo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const idLimpo = String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return slug ? `${prefixo}/${idLimpo}-${slug}` : `${prefixo}/${idLimpo}`
}