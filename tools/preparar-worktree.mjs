/**
 * Cria o worktree de uma task e registra na estado, SEM despachar agente.
 *
 * Usado quando a pessoa optou por implementar direto e deixar o orq apenas
 * como portão (review roda os gates, integrate só aprova o que passou).
 * Reusa os módulos do próprio orq para que branch, base e formato do estado
 * fiquem idênticos ao caminho normal — nada de convenção parallela.
 *
 *   node preparar-worktree.mjs T-010
 */
import { carregarConfig, repoDoComponente, componentesDaTask } from '../src/core/config.mjs'
import * as git from '../src/core/git.mjs'
import { TaskStore } from '../src/core/taskstore.mjs'
import { prepararAmbiente, subdiretoriosDeGate } from '../src/core/review.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const id = process.argv[2]
if (!id) {
  console.error('uso: node preparar-worktree.mjs <T-XXX>')
  process.exit(1)
}

const cfg = await carregarConfig()
const store = new TaskStore(cfg.stateDir)
const task = store.obter(id)
if (!task) {
  console.error(`${id} nao existe`)
  process.exit(1)
}

const comps = componentesDaTask(cfg, task)
const principal = comps[0]
const repo = repoDoComponente(cfg, principal)

const branch = git.branchParaTask(task.id, task.titulo, cfg.branchPrefix)
const baseRef = task.baseRef || cfg.componentes[principal]?.branch || 'HEAD'
const worktree = join(cfg.worktreesDir, task.id, principal)

if (existsSync(worktree)) {
  console.log(`worktree ja existe: ${worktree}`)
} else {
  const wt = git.criarWorktree({ repo, dir: worktree, branch, baseRef })
  console.log(`base: ${wt.baseSha}`)
  store.atualizar(
    task.id,
    { worktree, branch, baseSha: wt.baseSha, baseRef },
    'worktree-criado',
    { worktree, branch },
  )
}

// Espelha o node_modules do repo base por junction, como o runner faz. Sem
// isto o worktree não tem dependência nenhuma e o gate falha com "tsc não é
// reconhecido" — falha de ambiente vestida de falha de código.
const gates = cfg.componentes[principal]?.gates || []
const env = prepararAmbiente(worktree, repo, subdiretoriosDeGate(gates))
console.log(`ambiente: ${env.criados.length} junction(s) criada(s)`)
if (env.ignorados.length) console.log(`  ignorado: ${env.ignorados.join(' | ')}`)

const atual = store.obter(task.id).estado

// O runner marca a task como `em-andamento` quando despacha e como
// `aguardando-revisao` quando a execução termina. Como aqui ninguém despacha,
// o review reprova na transição ("em-andamento -> aguardando-integracao")
// mesmo com todos os gates verdes. Percorre o caminho legal em vez de forçar,
// e ignora transições whose from-state is ahead of where we are.
const ALVO = 'aguardando-revisao'
const ordem = ['pendente', 'aguardando-dependencia', 'pronta', 'em-andamento', 'aguardando-revisao']
let estado = store.obter(task.id).estado
if (estado === 'bloqueada') {
  store.mudarEstado(task.id, 'pronta', {}, 'worktree recreado')
  estado = 'pronta'
}
const de = ordem.indexOf(estado)
const para = ordem.indexOf(ALVO)
for (let i = de + 1; i <= para; i++) {
  store.mudarEstado(task.id, ordem[i], {}, `worktree pronto (${estado} -> ${ordem[i]})`)
}

const t = store.obter(task.id)
console.log(`\n${t.id} ${t.titulo}`)
console.log(`  worktree: ${t.worktree}`)
console.log(`  branch:   ${t.branch}`)
console.log(`  base:     ${t.baseSha}`)
console.log(`  estado:   ${t.estado}`)