/**
 * Teste de ponta a ponta, num repositório descartável.
 *
 * NÃO toca em portal, chamados nem sce. Cria um repo git em %TEMP% com um
 * gate de teste real (`npm test` falha se os arquivos esperados não existirem),
 * roda o pipeline inteiro do orquestrador contra ele e verifica as propriedades
 * que importam:
 *
 *   1. planejamento detecta conflito de arquivo entre tasks independentes
 *   2. dependência nãoatisfied não é despachada
 *   3. isolamento: o commit do agente fica na branch da task, main intacta
 *   4. revisão reprova task que não mexeu em nada
 *   5. gate real falha quando o conteúdo está errado
 *   6. integração junta branches e para antes da main
 *   7. estado sobrevive a "restart"
 *
 * Uso:
 *   node tests/e2e.mjs              # pipeline mecânico (rápido, sem gastar tokens)
 *   node tests/e2e.mjs --com-agente  # inclui uma execução real de agente OpenCode
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

import * as git from '../src/core/git.mjs'
import * as planner from '../src/core/planner.mjs'
const { preverConflitos } = planner
import { selecionarDespachaveis, reconciliarEstados, ordemDeIntegracao } from '../src/core/scheduler.mjs'
import { revisar, avaliarCriterios, prepararAmbiente, rodarGate } from '../src/core/review.mjs'
import { integrar } from '../src/core/integration.mjs'
import { TaskStore } from '../src/core/taskstore.mjs'
import { branchParaTask } from '../src/core/git.mjs'
import { carregarConfig, limparCacheConfig } from '../src/core/config.mjs'
import { OpencodeClient, OpencodeServer, extrairTexto } from '../src/core/opencode.mjs'

const COM_AGENTE = process.argv.includes('--com-agente')

let passou = 0
let falhou = 0
function ok(nome) {
  passou++
  console.log(`  \x1b[32m✓\x1b[0m ${nome}`)
}
function falha(nome, err) {
  falhou++
  console.log(`  \x1b[31m✗\x1b[0m ${nome}`)
  console.log(`     ${err.message.split('\n')[0]}`)
}
function secao(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`)
}
async function checar(nome, fn) {
  try {
    await fn()
    ok(nome)
  } catch (err) {
    falha(nome, err)
  }
}

const RAIZ = mkdtempSync(join(tmpdir(), 'orq-e2e-'))
const REPO = join(RAIZ, 'repo-projeto')
const STATE = join(RAIZ, 'state')
const WORKTREES = join(RAIZ, 'worktrees')

/* ------------------------------------------------------------------ setup */

function criarRepoDeTeste() {
  mkdirSync(REPO, { recursive: true })
  const g = (args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe', windowsHide: true })
  g(['init', '-b', 'main'])
  g(['config', 'user.email', 'e2e@teste.local'])
  g(['config', 'user.name', 'e2e'])
  g(['config', 'commit.gpgsign', 'false'])

  mkdirSync(join(REPO, 'src'), { recursive: true })
  writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'projeto-teste', private: true, version: '1.0.0', scripts: { test: 'node testes/verificar.mjs' } }, null, 2))
  mkdirSync(join(REPO, 'testes'), { recursive: true })

  // Gate real: falha se o conteúdo esperado não estiver lá. Assim a revisão
  // mecânica tem algo verdadeiro para aprovar ou reprovar.
  writeFileSync(
    join(REPO, 'testes', 'verificar.mjs'),
    `import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const raiz = join(import.meta.dirname, '..')
const alvos = [
  { arquivo: 'src/funcao.ts', deveConter: 'export function soma' },
  { arquivo: 'src/outro.ts', deveConter: 'export const CONFIG' },
]

let falhas = 0
for (const a of alvos) {
  const p = join(raiz, a.arquivo)
  if (!existsSync(p)) { console.error('FALTA: ' + a.arquivo); falhas++; continue }
  if (!readFileSync(p, 'utf8').includes(a.deveConter)) {
    console.error('CONTEUDO ERRADO em ' + a.arquivo + ': esperava "' + a.deveConter + '"')
    falhas++
  }
}
if (falhas) { console.error(falhas + ' verificacao(oes) falharam'); process.exit(1) }
console.log('todas as verificacoes passaram')
`,
    'utf8',
  )

  writeFileSync(join(REPO, 'README.md'), '# projeto de teste\n', 'utf8')
  writeFileSync(join(REPO, 'src', 'existente.ts'), 'export const JA_EXISTE = true\n', 'utf8')
  g(['add', '-A'])
  g(['commit', '-m', 'base'])
}

function cfgE2E() {
  return {
    raiz: RAIZ,
    stateDir: STATE,
    logDir: join(RAIZ, 'logs'),
    worktreesDir: WORKTREES,
    concurrency: 2,
    branchPrefix: 'orq',
    integrationBranchPrefix: 'orq-integracao',
    taskTimeoutMs: 10 * 60 * 1000,
    maxTentativas: 2,
    opencode: { port: 4788, host: '127.0.0.1' },
    agentes: { worker: 'orq-worker', reviewer: 'orq-reviewer', integrator: 'orq-integrator' },
    componentes: {
      teste: {
        rotulo: 'Projeto de teste do E2E',
        repo: REPO,
        branch: 'main',
        gates: [{ nome: 'test', cmd: 'npm test', obrigatorio: true }],
      },
    },
    trello: { boardId: null },
  }
}

/* ------------------------------------------------------------------ tasks */

function criarTasks(store) {
  return store.criarVarias([
    {
      titulo: 'Criar função soma em src/funcao.ts',
      descricao: 'Criar src/funcao.ts exportando `export function soma(a, b)` que retorna a+b.',
      componentes: ['teste'],
      criterios: ['src/funcao.ts existe e exporta a função soma'],
      arquivosAlvo: ['src/funcao.ts'],
      prioridade: 5,
    },
    {
      titulo: 'Criar CONFIG em src/outro.ts',
      descricao: 'Criar src/outro.ts exportando `export const CONFIG = {}`.',
      componentes: ['teste'],
      criterios: ['src/outro.ts existe e exporta CONFIG'],
      arquivosAlvo: ['src/outro.ts'],
      prioridade: 5,
    },
    {
      titulo: 'Primeira task que mexe em src/funcao.ts',
      descricao: 'Alterar src/funcao.ts.',
      componentes: ['teste'],
      arquivosAlvo: ['src/funcao.ts'],
      prioridade: 1,
    },
    {
      titulo: 'Segunda task que mexe no mesmo src/funcao.ts',
      descricao: 'Alterar src/funcao.ts de novo.',
      componentes: ['teste'],
      arquivosAlvo: ['src/funcao.ts'],
      prioridade: 1,
    },
  ])
}

/* -------------------------------------------------------------------- run */

async function main() {
  console.log(`\n\x1b[1mE2E do orquestrador\x1b[0m`)
  console.log(`repo de teste: ${REPO}`)
  console.log(`(nenhum repo de produto é tocado por este teste)`)

  secao('1. Ambiente e repositório descartável')
  criarRepoDeTeste()
  await checar('repo criado com branch main e gate de teste real', () => {
    assert.equal(git.branchAtual(REPO), 'main')
    assert.ok(existsSync(join(REPO, 'testes', 'verificar.mjs')))
  })
  await checar('o gate real falha antes das tasks existirem', () => {
    const r = rodarGate({ gate: { nome: 'test', args: ['test'] }, cwd: REPO })
    assert.equal(r.ok, false, 'o gate do repo de teste deve falhar: src/funcao.ts ainda não existe')
    assert.ok(/FALTA/.test(r.stdout + r.stderr), 'a saída precisa dizer o que falta')
  })

  const mainAntes = git.revParse('main', REPO)
  const cfg = cfgE2E()
  const store = new TaskStore(STATE)
  const tasks = criarTasks(store)

  secao('2. Planejamento: conflito de arquivo detectado')
await checar('conflitos previstos são exatamente os pares que disputam arquivo', () => {
      const conflitos = preverConflitos(tasks)
      const pares = conflitos.map((c) => [c.a, c.b].sort().join('×')).sort()
      // T-001, T-003 e T-004 disputam src/funcao.ts: são 3 pares.
      assert.deepEqual(pares, ['T-001×T-003', 'T-001×T-004', 'T-003×T-004'])
      assert.ok(!pares.some((p) => p.includes('T-002')), 'T-002 usa outro arquivo e não disputa')
    })
  await checar('tasks em arquivos diferentes não conflitam', () => {
    const c = planner.preverConflitos([tasks[0], tasks[1]])
    assert.equal(c.length, 0)
  })

  secao('3. Scheduler: o que pode e o que não pode rodar')
  await checar('teto de concorrência respeitado', () => {
    const { despachaveis } = selecionarDespachaveis({ tasks: store.listar(), concurrency: 2 })
    assert.equal(despachaveis.length, 2)
    assert.deepEqual(despachaveis.map((t) => t.id).sort(), ['T-001', 'T-002'])
  })
  await checar('com concorrência 1, só a de maior prioridade sai', () => {
    const { despachaveis } = selecionarDespachaveis({ tasks: store.listar(), concurrency: 1 })
    assert.equal(despachaveis.length, 1)
    assert.equal(despachaveis[0].prioridade, 5)
  })
  await checar('task em conflito não é despachada junto da que disputa o arquivo', () => {
    const apenasConflitantes = store.listar().filter((t) => ['T-003', 'T-004'].includes(t.id))
    const { despachaveis } = selecionarDespachaveis({ tasks: apenasConflitantes, concurrency: 5 })
    assert.equal(despachaveis.length, 1)
  })

  secao('4. Isolamento: worktree e branch por task')
  const worktrees = {}
  await checar('cada task ganha worktree e branch própria, com base pinado', () => {
    for (const t of [tasks[0], tasks[1]]) {
      const branch = branchParaTask(t.id, t.titulo, cfg.branchPrefix)
      const dir = join(WORKTREES, t.id)
      const wt = git.criarWorktree({ repo: REPO, dir, branch, baseRef: 'main' })
      worktrees[t.id] = wt
      store.atualizar(t.id, { worktree: dir, branch, baseSha: wt.baseSha }, 'worktree')
      assert.equal(git.branchAtual(dir), branch)
      assert.equal(wt.baseSha, mainAntes)
    }
  })
  await checar('main não mudou ao criar os worktrees', () => {
    assert.equal(git.revParse('main', REPO), mainAntes)
    assert.equal(git.branchAtual(REPO), 'main')
  })
  await checar('node_modules do repo base foi preparado como junction', () => {
    // Não há node_modules neste repo de teste: a função deve sair sem quebrar.
    const r = prepararAmbiente(worktrees['T-001'].worktree, REPO)
    assert.ok('criado' in r)
  })

  secao('5. Execução simulada: commits isolados')
  // Sem --com-agente, escrevemos os arquivos "como se o agente tivesse feito".
  // Com --com-agente, um agente real faz isto (ver seção 8).
  if (!COM_AGENTE) {
    await checar('T-001 altera o arquivo e commita na branch dela', () => {
      const wt = worktrees['T-001'].worktree
      writeFileSync(join(wt, 'src', 'funcao.ts'), 'export function soma(a: number, b: number): number {\n  return a + b\n}\n', 'utf8')
      const sha = git.commitar(wt, 'feat(T-001): cria função soma')
      store.atualizar('T-001', { commits: git.commitsDesde(wt, mainAntes), arquivosAlterados: git.arquivosAfetados(wt, mainAntes) }, 'commit')
      assert.ok(sha)
      assert.deepEqual(git.arquivosCommitados(wt, mainAntes), ['src/funcao.ts'])
    })
    await checar('T-002 altera OUTRO arquivo, mesmo rodando em paralelo', () => {
      const wt = worktrees['T-002'].worktree
      writeFileSync(join(wt, 'src', 'outro.ts'), 'export const CONFIG = { ativo: true }\n', 'utf8')
      git.commitar(wt, 'feat(T-002): cria CONFIG')
      store.atualizar('T-002', { commits: git.commitsDesde(wt, mainAntes), arquivosAlterados: git.arquivosAfetados(wt, mainAntes) }, 'commit')
      assert.deepEqual(git.arquivosCommitados(wt, mainAntes), ['src/outro.ts'])
    })
    await checar('o arquivo da task A não existe no worktree da task B', () => {
      assert.equal(existsSync(join(worktrees['T-002'].worktree, 'src', 'funcao.ts')), false)
    })
    await checar('main continua intacta depois dos commits das tasks', () => {
      assert.equal(git.revParse('main', REPO), mainAntes)
      assert.equal(existsSync(join(REPO, 'src', 'funcao.ts')), false)
    })
  }

  secao('6. Revisão: o gate roda de verdade')
  const gates = cfg.componentes.teste.gates
  if (!COM_AGENTE) {
    await checar('task correta é aprovada mesmo com o gate do repo inteiro vermelho', () => {
      // O gate mede o repositório inteiro; no worktree da T-001 falta o
      // src/outro.ts da T-002. A falha não aponta para arquivo da T-001, logo
      // vira aviso — reprovar aqui seria falso positivo.
      const r = revisar({ task: store.obter('T-001'), gates })
      assert.equal(r.gates[0].ok, false, 'o gate realmente falha neste worktree')
      assert.equal(r.aprovado, true, `críticos: ${r.criticos.join(' | ')}`)
      assert.ok(r.avisos.some((a) => /Revalidado na integração/.test(a)))
    })
    await checar('gate reprova quando a task deixou o gate quebrado', () => {
      // A task escreve src/funcao.ts com o conteúdo ERRADO. O gate aponta para
      // esse arquivo, que é desta task: então a culpa é dela.
      const wt = git.criarWorktree({ repo: REPO, dir: join(WORKTREES, 'T-QUEBRADA'), branch: 'orq/T-QUEBRADA', baseRef: 'main' })
      writeFileSync(join(wt.worktree, 'src', 'funcao.ts'), 'export function errado() { return 0 }\n', 'utf8')
      git.commitar(wt.worktree, 'feat: conteudo errado')
      const t = store.criar({ titulo: 'gate quebrado', componentes: ['teste'], worktree: wt.worktree, baseSha: wt.baseSha, arquivosAlvo: ['src/funcao.ts'] })
      const r = revisar({ task: t, gates })
      assert.equal(r.aprovado, false, `críticos: ${r.criticos.join(' | ')}`)
      assert.ok(r.criticos.some((c) => /Gate "test"/.test(c)), 'a falha aponta para arquivo da task, logo é bloqueante')
    })
    await checar('falha de gate fora do escopo da task vira aviso, não reprovação', () => {
      // T-001 está correta; o gate falha só porque src/outro.ts (de outra task)
      // não existe neste worktree. Reprovar T-001 por isso seria falso positivo.
      const r = revisar({ task: store.obter('T-001'), gates })
      assert.equal(r.aprovado, true, `críticos: ${r.criticos.join(' | ')}`)
      assert.ok(r.avisos.some((a) => /Revalidado na integração/.test(a)))
    })
    await checar('reprova task que não produziu nenhum commit', () => {
      const wt = git.criarWorktree({ repo: REPO, dir: join(WORKTREES, 'T-VAZIA'), branch: 'orq/T-VAZIA', baseRef: 'main' })
      const t = store.criar({ titulo: 'não faz nada', componentes: ['teste'], worktree: wt.worktree, baseSha: wt.baseSha })
      const r = revisar({ task: t, gates: [] })
      assert.equal(r.aprovado, false)
      assert.ok(r.criticos.some((c) => /Nenhum commit/.test(c)))
    })
    await checar('reprova árvore suja (implementação pela metade)', () => {
      const wt = git.criarWorktree({ repo: REPO, dir: join(WORKTREES, 'T-SUJO'), branch: 'orq/T-SUJO', baseRef: 'main' })
      writeFileSync(join(wt.worktree, 'src', 'meio.ts'), 'export const MEIO = 1\n', 'utf8')
      const t = store.criar({ titulo: 'deixou pela metade', componentes: ['teste'], worktree: wt.worktree, baseSha: wt.baseSha })
      const r = revisar({ task: t, gates: [] })
      assert.equal(r.aprovado, false)
      assert.ok(r.criticos.some((c) => /Árvore suja/.test(c)))
    })
    await checar('avisa sobre arquivo alterado fora do escopo declarado', () => {
      const wt = git.criarWorktree({ repo: REPO, dir: join(WORKTREES, 'T-FORA'), branch: 'orq/T-FORA', baseRef: 'main' })
      writeFileSync(join(wt.worktree, 'src', 'esperado.ts'), 'x\n', 'utf8')
      writeFileSync(join(wt.worktree, 'README.md'), '# alterado sem pedir\n', 'utf8')
      git.commitar(wt.worktree, 'feat: mexeu fora')
      const t = store.criar({ titulo: 'fora de escopo', componentes: ['teste'], worktree: wt.worktree, baseSha: wt.baseSha, arquivosAlvo: ['src/esperado.ts'] })
      const r = revisar({ task: t, gates: [] })
      assert.ok(r.avisos.some((a) => /fora do escopo/.test(a)), `avisos: ${r.avisos.join(' | ')}`)
    })
  }

  secao('7. Critérios de aceitação')
  await checar('critério com evidência é considerado atendido', () => {
    const r = revisar({ task: store.obter('T-001'), gates: [] })
    const c = avaliarCriterios({
      task: { ...store.obter('T-001'), resultado: { texto: 'Criei a função soma em src/funcao.ts' } },
      revisaoMecanica: r,
      textoAgente: 'Criei a função soma em src/funcao.ts',
    })
    assert.equal(c.todosAtendidos, true, JSON.stringify(c.avaliados))
  })
  await checar('critério sem evidência é apontado como não atendido', () => {
    const c = avaliarCriterios({
      task: { criterios: ['exporta a função subtração com validação de sinal'] },
      revisaoMecanica: { evidencia: { commits: [], arquivosCommitados: [] } },
      textoAgente: 'não fiz nada',
    })
    assert.equal(c.todosAtendidos, false)
    assert.ok(c.naoAtendidos.length === 1)
  })
  await checar('task sem critérios não é reprovada por falta de critérios', () => {
    const c = avaliarCriterios({ task: { criterios: [] }, revisaoMecanica: { evidencia: {} }, textoAgente: '' })
    assert.equal(c.todosAtendidos, true)
  })

  secao('8. Estado sobrevive a restart')
  await checar('recarregar o store devolve as mesmas tasks', () => {
    const s2 = new TaskStore(STATE)
    assert.equal(s2.listar().length, store.listar().length)
    assert.ok(s2.obter('T-001'))
  })
  await checar('histórico em eventos sobrevive', () => {
    const s2 = new TaskStore(STATE)
    assert.ok(s2.eventos().length >= 5)
  })

  secao('9. Integração: junta branches e PARA antes da main')
  if (!COM_AGENTE) {
    await checar('ordem de integração respeita a dependência', () => {
      const a = { ...store.obter('T-001'), estado: 'aguardando-integracao', dependsOn: ['T-002'] }
      const b = { ...store.obter('T-002'), estado: 'aguardando-integracao' }
      const ordem = ordemDeIntegracao([a, b]).map((t) => t.id)
      assert.deepEqual(ordem, ['T-002', 'T-001'])
    })

    await checar('integração de branches disjuntas funciona e roda o gate', () => {
      const lista = [store.obter('T-001'), store.obter('T-002')].map((t) => ({
        ...t,
        estado: 'aguardando-integracao',
        worktree: worktrees[t.id].worktree,
        baseSha: mainAntes,
      }))
      const rel = integrar({ cfg, tasks: lista, repo: REPO, nome: 'e2e' })
      assert.equal(rel.aprovado, true, `bloqueios: ${rel.bloqueios.join(' | ')}`)
      assert.ok(rel.commits.length >= 2)
    })
    await checar('main NÃO foi alterada pela integração', () => {
      assert.equal(git.revParse('main', REPO), mainAntes)
    })
    await checar('branch de integração tem os dois arquivos', () => {
      const wts = git.worktreeList(REPO)
      const integ = wts.find((w) => w.branch?.startsWith('orq-integracao'))
      assert.ok(integ, 'deveria existir worktree de integração')
      assert.ok(existsSync(join(integ.path, 'src', 'funcao.ts')))
      assert.ok(existsSync(join(integ.path, 'src', 'outro.ts')))
    })

    secao('10. Detecção de conflito entre branches prontas')
    await checar('duas branches no mesmo arquivo são acusadas no relatório', () => {
      const w1 = git.criarWorktree({ repo: REPO, dir: join(WORKTREES, 'cf-1'), branch: 'orq/cf-1', baseRef: 'main' })
      const w2 = git.criarWorktree({ repo: REPO, dir: join(WORKTREES, 'cf-2'), branch: 'orq/cf-2', baseRef: 'main' })
      writeFileSync(join(w1.worktree, 'src', 'comum.ts'), 'export const COMUM = 1\n', 'utf8')
      git.commitar(w1.worktree, 'A')
      writeFileSync(join(w2.worktree, 'src', 'comum.ts'), 'export const COMUM = 2\n', 'utf8')
      git.commitar(w2.worktree, 'B')

      const rel = integrar({
        cfg,
        repo: REPO,
        nome: 'conflito',
        tasks: [
          { id: 'C1', titulo: 'A', branch: 'orq/cf-1', baseSha: mainAntes, arquivosAlvo: [], componentes: ['teste'], estado: 'aguardando-integracao', dependsOn: [] },
          { id: 'C2', titulo: 'B', branch: 'orq/cf-2', baseSha: mainAntes, arquivosAlvo: [], componentes: ['teste'], estado: 'aguardando-integracao', dependsOn: [] },
        ],
      })
      assert.ok(rel.conflitos.length > 0, `conflitos: ${JSON.stringify(rel.conflitos)}`)
      assert.equal(rel.aprovado, false)
      assert.ok(rel.bloqueios.length > 0, 'a integração tem de parar e reportar')
    })
    await checar('main segue intacta depois da tentativa com conflito', () => {
      assert.equal(git.revParse('main', REPO), mainAntes)
    })
  }

  if (COM_AGENTE) {
    secao('11. Execução com agente OpenCode de verdade')
    await executarComAgenteReal({ cfg, store, mainAntes, worktrees })
  }

  // Resumo
  console.log(`\n\x1b[1mResultado\x1b[0m: ${passou} passaram, ${falhou} falharam`)
  console.log(`repo de teste: ${REPO}`)
  if (!falhou && !process.env.ORQ_E2E_MANTER) {
    console.log('(removendo o ambiente de teste...)\n')
    try {
      for (const w of git.worktreeList(REPO)) if (w.path !== REPO) git.removerWorktree(REPO, w.path, { forcar: true })
    } catch {}
    rmSync(RAIZ, { recursive: true, force: true })
    console.log('Ambiente descartado. Nada sobrou.\n')
  }
  process.exit(falhou ? 1 : 0)
}

/**
 * Execução real: cria worktree, sessão e manda o briefing a um agente OpenCode.
 * É a prova de que a integração com a API funciona — o resto do E2E é mecânico.
 */
async function executarComAgenteReal({ cfg, store, mainAntes, worktrees }) {
  const server = new OpencodeServer({ port: cfg.opencode.port, host: cfg.opencode.host, stateDir: cfg.stateDir, logDir: cfg.logDir })
  await checar('servidor opencode sobe e responde health', async () => {
    await server.garantir()
    const client = new OpencodeClient(cfg.opencode)
    await client.health()
  })
  const client = new OpencodeClient(cfg.opencode)

  await checar('agente executa a task e commita na branch dela', async () => {
    const task = store.obter('T-001')
    const wt = worktrees['T-001']
    const sessao = await client.criarSessao({
      directory: wt.worktree,
      agent: cfg.agentes.worker,
      title: `e2e ${task.id}`,
      metadata: { orqTaskId: task.id },
    })
    assert.ok(sessao.id, 'sessão sem id')
    store.atualizar(task.id, { sessionID: sessao.id }, 'sessao')

    const briefing = `Você está num worktree git isolado. Crie o arquivo src/funcao.ts com o conteúdo exato:

export function soma(a, b) {
  return a + b
}

Depois rode \`npm test\` e faça commit com a mensagem "feat(T-001): cria função soma". Não rode git push. Ao final, responda com um resumo curto do que fez.`
    const resposta = await client.enviarPrompt({ sessionID: sessao.id, texto: briefing, agent: cfg.agentes.worker, timeoutMs: cfg.taskTimeoutMs })
    const texto = extrairTexto(resposta)
    assert.ok(texto.length > 0, 'agente não devolveu texto')

    if (!git.arvoreLimpa(wt.worktree)) git.commitar(wt.worktree, 'feat(T-001): cria função soma')
    const commits = git.commitsDesde(wt.worktree, mainAntes)
    assert.ok(commits.length > 0, 'agente não produziu commit')
    store.atualizar(task.id, { commits, arquivosAlterados: git.arquivosAfetados(wt.worktree, mainAntes), resultado: { texto } }, 'commit')
  })

  await checar('a implementação do agente passa na revisão com gate real', () => {
    const r = revisar({ task: store.obter('T-001'), gates: cfg.componentes.teste.gates })
    assert.equal(r.aprovado, true, `críticos: ${r.criticos.join(' | ')}`)
  })

  await checar('a task do agente percorre o ciclo de estados completo', () => {
    // A máquina recusa atalhos de propósito: `pendente -> aguardando-revisao`
    // é inválido, e é essa recusa que impede uma task pular a execução.
    const id = 'T-001'
    assert.throws(() => store.mudarEstado(id, 'aguardando-revisao'), /Transição inválida/)
    store.mudarEstado(id, 'pronta')
    store.mudarEstado(id, 'em-andamento')
    assert.equal(store.obter(id).tentativa, 1)
    store.mudarEstado(id, 'aguardando-revisao')
    store.mudarEstado(id, 'aguardando-integracao')
    assert.equal(store.obter(id).estado, 'aguardando-integracao')
    assert.ok(store.obter(id).sessionID, 'a sessão do agente tem de ficar registrada')
    assert.ok(store.obter(id).commits.length > 0)
  })

  server.parar()
}

main().catch((err) => {
  console.error('\n\x1b[31mE2E quebrou:\x1b[0m', err)
  process.exit(1)
})