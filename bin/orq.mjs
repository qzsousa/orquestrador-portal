#!/usr/bin/env node
/**
 * orq — orquestrador multiagente para OpenCode.
 *
 * CLI. Cada comando é uma operação pequena e explícita: quem coordena é a
 * pessoa, o software coordena os agentes.
 *
 *   orq init                      detecta componentes e valida ambiente
 *   orq add "<texto>"             cria task (também aceita --dep, --comp, --crit)
 *   orq plan                      decompõe, deduz dependências, mostra conflitos
 *   orq run [--max N]             executa a fila até acabar
 *   orq status                    estado de tudo
 *   orq review <id>               revisão manual de uma task
 *   orq integrate [--aplicar]     integra aprovadas (para antes da main)
 *   orq recover                   reidrata o estado após reinício
 *   orq adopt <id>                adota commits de agente que terminou sem o orquestrador
 *   orq clean <id> [--worktree]   descarta worktree/branch de uma task
 *   orq trello-sync               importa cards do Trello
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { TaskStore } from '../src/core/taskstore.mjs'
import { carregarConfig, repoDoComponente, componentesDaTask, tabelaDeModelos, avisosDeModelo, catalogoDeModelos, mcpAtivos, escolherModelo } from '../src/core/config.mjs'
import { calcularDificuldade } from '../src/core/difficulty.mjs'
import { OpencodeClient, OpencodeServer } from '../src/core/opencode.mjs'
import { executarTask, reanexarTask } from '../src/core/runner.mjs'
import { revisar, avaliarCriterios, limparAmbiente } from '../src/core/review.mjs'
import { integrar, aplicarNaPrincipal, limparIntegracao } from '../src/core/integration.mjs'
import { reconciliarEstados, selecionarDespachaveis, motivoBloqueio } from '../src/core/scheduler.mjs'
import * as planner from '../src/core/planner.mjs'
import * as git from '../src/core/git.mjs'
import * as trello from '../src/core/trello.mjs'

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}
const usarCor = process.stdout.isTTY && !process.env.NO_COLOR
const p = (cor, s) => (usarCor ? `${cor}${s}${C.reset}` : s)
const log = (...a) => console.log(...a)
const erro = (...a) => console.error(p(C.red, ...a))

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const chave = a.slice(2)
      const proximo = argv[i + 1]
      // Flag repetida acumula em array em vez de sobrescrever. Antes, `--crit A
      // --crit B` guardava so B: os criterios de aceitacao sao o que a revisao
      // avalia, e perder a maioria deles nao dava erro nenhum - a task Passing
      // com metade dos criterios e o pior jeito de falhar.
      if (proximo === undefined || proximo.startsWith('--')) {
        flags[chave] = flags[chave] === undefined ? true : [].concat(flags[chave], true)
      } else {
        flags[chave] = flags[chave] === undefined ? proximo : [].concat(flags[chave], proximo)
        i++
      }
    } else {
      pos.push(a)
    }
  }
  return { pos, flags }
}

/** Valor de flag como lista: um `--crit A --crit B` e um `--crit "A;B"`. */
function listaDeFlag(valor, sep = /[;,]/) {
  if (valor === undefined || valor === true) return undefined
  return [].concat(valor)
    .flatMap((v) => String(v).split(sep))
    .map((s) => s.trim())
    .filter(Boolean)
}

function storeDe(cfg) {
  return new TaskStore(cfg.stateDir)
}

/* ------------------------------------------------------------------ init */

async function cmdInit() {
  const cfg = await carregarConfig()
  log(p(C.bold, 'orq — verificação de ambiente\n'))

  log(p(C.bold, 'Componentes:'))
  let ok = true
  for (const [nome, c] of Object.entries(cfg.componentes)) {
    const existe = existsSync(c.repo)
    const gitOk = existe && git.isRepo(c.repo)
    const marca = !existe ? p(C.red, '✗') : gitOk ? p(C.green, '✓') : p(C.yellow, '!')
    log(`  ${marca} ${nome.padEnd(9)} ${c.repo}${existe ? '' : '  ← NÃO EXISTE'}`)
    if (!existe || !gitOk) ok = false
    if (gitOk) log(`      ${C.dim}branch: ${git.branchAtual(c.repo)} | gates: ${(c.gates || []).map((g) => (Array.isArray(g.args) ? 'npm ' + g.args.join(' ') : g.cmd)).join(', ') || 'nenhum'}${C.reset}`)
  }

  log(`\n${p(C.bold, 'Diretórios:')}`)
  log(`  estado:     ${cfg.stateDir}`)
  log(`  worktrees:  ${cfg.worktreesDir}`)
  log(`  logs:       ${cfg.logDir}`)

  log(`\n${p(C.bold, 'OpenCode:')}`)
  const client = new OpencodeClient(cfg.opencode)
  const noAr = await client.health().then(() => true).catch(() => false)
  log(`  porta ${cfg.opencode.port}: ${noAr ? p(C.green, 'respondendo') : p(C.yellow, 'não está no ar (será iniciado no orq run)')}`)

log(`\n${p(C.bold, 'Agentes:')}`)
  // Só os papéis: `cfg.agentes` também guarda `workerModel`, que não é um
  // agente. Iterar o objeto inteiro listava um agente chamado `workerModel`
  // com o aviso de "não instalado" - ruído que escondia os três reais.
  //
  // O caminho conferido é o GLOBAL (~/.config/opencode/agent), não
  // `agents/` no repo. Conferir o repo dá "tudo instalado" numa máquina em que
  // o servidor não acha nenhum deles: a sessão é criada, o prompt_async morre
  // com UnknownError e o agente não dá sinal de vida até o tempo acabar. O
  // repo é a fonte; o que o servidor lê é o destino.
  const dirAgentes = join(process.env.USERPROFILE || process.env.HOME, '.config', 'opencode', 'agent')
  for (const papel of ['worker', 'reviewer', 'integrator']) {
    const nome = cfg.agentes?.[papel]
    if (!nome) continue
    const instalado = existsSync(join(dirAgentes, `${nome}.md`))
    const noRepo = existsSync(join(cfg.raiz, 'agents', `${nome}.md`))
    const dica = instalado ? '' : noRepo ? 'no repo, mas NÃO instalado (rode: orq install-agents)' : 'ausente no repo também'
    log(`  ${papel.padEnd(10)} ${nome}${instalado ? '' : p(C.yellow, `  ⚠ ${dica}`)}`)
  }

  // A rota de modelo fica no init, e nao num `orq models`: enquanto ela nao
  // esta visivel, a unica forma de descobrir por que a T-012 rodou com um
  // modelo e outro e abrir sessao antiga. Aqui ela aparece antes de gastar
  // tempo de agente.
  log(`\n${p(C.bold, 'Roteamento de modelo (por dificuldade):')}`)
  // A largura da coluna vem dos próprios nomes, não de um número chutado. Com
  // nome de 36 caracteres numa coluna de 34, a tabela vira uma linha só — e
  // "modelo errado" fica invisível justamente na linha que existe para
  // mostrar o modelo.
  const tabela = tabelaDeModelos(cfg)
  const nomes = tabela.flatMap((l) => Object.values(l.porNivel).filter(Boolean).map(String))
  const L = Math.max(12, ...nomes.map((n) => n.length)) + 2
  log(p(C.dim, `  ${'componente'.padEnd(11)} ${'facil'.padEnd(L)} ${'medio'.padEnd(L)} ${'dificil'}`))
  for (const linha of tabela) {
    const celula = (n) => (linha.porNivel[n] ? String(linha.porNivel[n]) : p(C.dim, 'default')).padEnd(L)
    log(`  ${linha.componente.padEnd(11)} ${celula('facil')}${celula('medio')}${linha.porNivel.dificil || p(C.dim, 'default')}`)
  }
  // O catalogo vem do servidor, e nao de uma lista escrita a mao: um id que o
  // provider nao tem nao derruba o `serve`, ele so faz a sessao nunca produzir
  // mensagem. E o aviso tem que vir de quem sabe.
  const catalogo = await catalogoDeModelos(cfg)
  if (catalogo.length) log(p(C.dim, `  (catálogo do servidor: ${catalogo.length} modelos em ${new Set(catalogo.map((m) => m.split('/')[0])).size} provider(s))`))
  const avisos = avisosDeModelo(cfg, catalogo)
  if (avisos.length) {
    log(`\n${p(C.yellow, '  Aviso:')} modelo fora do catálogo:`)
    for (const a of avisos) log(`    ${a}`)
    log(p(C.dim, '    Um id inválido não derruba o servidor: a sessão é criada e nunca responde, e a task fica em-andamento para sempre.'))
    log(p(C.dim, '    Veja os ids reais com: orq init (com o servidor no ar) ou em /config/providers.'))
  }

  const mcp = mcpAtivos(cfg)
  log(`\n${p(C.bold, 'MCPs:')} ${mcp.length ? p(C.green, mcp.length + ' habilitado(s)') : p(C.yellow, 'nenhum habilitado')}`)
  // Sem os flags de -y e o nome do pacote: o resto é o que o MCP recebe, e é isso
  // que a pessoa quer conferir.
  for (const { nome, def } of mcp) {
    const alvo = def.command.filter((a) => !String(a).startsWith('-') && !String(a).includes('@')).join(' ')
    log(`  ${nome.padEnd(20)} ${alvo || '(sem argumento)'}`)
  }
  log(p(C.dim, '  "orq sync-mcp" escreve em ~/.config/opencode/opencode.jsonc (o servidor lê no próximo boot).'))

  log(`\n${ok ? p(C.green, 'Ambiente OK.') : p(C.yellow, 'Atenção: ajuste os pontos acima.')}`)
}

/* ------------------------------------------------------------------- add */

async function cmdAdd(flags, pos) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)

  const texto = pos.join(' ').trim()
  if (!texto) {
    erro('Informe o texto da task: orq add "O que precisa ser feito"')
    process.exit(1)
  }

  const t = store.criar({
    titulo: texto,
    descricao: texto,
    descricaoLonga: undefined,
componentes: listaDeFlag(flags.comp, /,/),
  criterios: listaDeFlag(flags.crit, /;/),
  dependsOn: listaDeFlag(flags.dep, /,/),
  arquivosAlvo: listaDeFlag(flags.arq, /,/),
    prioridade: flags.prio ? Number(flags.prio) : undefined,
  })

  log(p(C.green, `✓ ${t.id}`) + ` ${t.titulo}`)
  if (t.componentes.length) log(`  componentes: ${t.componentes.join(', ')}`)
  if (t.dependsOn.length) log(`  depende de:  ${t.dependsOn.join(', ')}`)
  log(`\n${p(C.dim, 'Rode "orq plan" para ver dependências e conflitos.')}`)
}

/* ------------------------------------------------------------------ plan */

async function cmdPlan(flags) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)

  let tasks = store.ativas()
  if (!tasks.length) {
    log(p(C.dim, 'Nenhuma task ativa.'))
    return
  }

  log(p(C.bold, `Planejando ${tasks.length} task(s)\n`))

  // 1. Decomposição por checklist (Trello).
  const novas = []
  for (const t of tasks) {
    if (t.checklists?.length && !flags['sem-decompor']) {
      const itens = t.checklists.filter((i) => !i.feito).map((i) => i.texto)
      if (itens.length > 1) {
        const subs = planner.subtarefasDeChecklist(t, itens)
        novas.push(...subs)
        log(p(C.cyan, `↳ ${t.id} tem ${itens.length} itens de checklist → ${subs.length} subtarefas`))
        store.atualizar(t.id, { decompostaEm: subs.map((s) => s.id) }, 'decomposta')
        store.remover(t.id)
      }
    }
  }
  if (novas.length) {
    tasks = store.ativas()
  }

  // 2. Sugestões de dependência — mostradas, NUNCA aplicadas sozinhas.
  const { sugestoes } = planner.sugerirDependencias(store.ativas())
  if (sugestoes.length) {
    log(p(C.bold, '\nSugestões de dependência (não aplicadas):'))
    log(p(C.dim, '  O orquestrador não confia na própria inferência: confirme com orq dep.'))
    for (const s of sugestoes) {
      const cor = s.confianca === 'media' ? C.yellow : C.dim
      log(`  ${p(cor, '?')} ${s.taskId} pode depender de ${s.dependeDe}`)
      log(`      ${C.dim}${s.motivo} (confiança ${s.confianca})${C.reset}`)
      log(`      ${C.dim}aplicar: orq dep ${s.taskId} --add ${s.dependeDe}${C.reset}`)
    }
  }

  // 3. Risco.
  for (const t of store.ativas()) {
    const risco = planner.avaliarRisco(t)
    if (risco !== t.risco) store.atualizar(t.id, { risco }, 'risco-avaliado')
  }

  // 4. Ciclo?
  const ciclo = planner.detectarCiclo(store.ativas())
  if (ciclo) {
    erro(`\n✗ Ciclo de dependências: ${ciclo.join(' → ')}`)
    erro('  Corrija as dependências antes de rodar.')
    process.exit(1)
  }

  // 5. Conflitos previstos.
  const conflitos = planner.preverConflitos(store.ativas())
  log(p(C.bold, '\nConflitos previstos:'))
  if (!conflitos.length) {
    log(p(C.green, '  nenhum — as tasks não disputam os mesmos arquivos'))
  } else {
    for (const c of conflitos) {
      log(`  ${p(c.severidade === 'alta' ? C.red : C.yellow, '⚠')} ${c.a} × ${c.b}`)
      log(`      ${c.arquivos.slice(0, 5).join(', ')}`)
      log(`      ${C.dim}${c.resolucao}${C.reset}`)
    }
  }

  // 6. Ordem.
  const ordem = planner.ordenarTopologicamente(store.ativas())
  log(p(C.bold, '\nOrdem de execução:'))
  for (const t of ordem) {
    const m = motivoBloqueio(t, store.ativas())
    const cor = t.risco === 'alto' ? C.red : t.risco === 'baixo' ? C.dim : C.yellow
    // Dificuldade e modelo entram aqui porque este e o ultimo lugar onde a
    // pessoa decide se vale despachar. Descobrir depois que a task rodou no
    // modelo errado nao tem reparo curto.
    const diff = calcularDificuldade(t)
    const modelo = escolherModelo(cfg, componentesDaTask(cfg, t)[0], diff)
    const corDiff = diff.nivel === 'dificil' ? C.red : diff.nivel === 'medio' ? C.yellow : C.dim
    log(
      `  ${p(C.bold, t.id)} ${t.titulo.slice(0, 44).padEnd(44)} ` +
        `${p(cor, t.risco.padEnd(6))} ${p(corDiff, diff.nivel.padEnd(7))} ${C.dim}${(modelo || 'default do servidor')}${C.reset}` +
        (m ? `  ${p(C.yellow, m.mensagem)}` : ''),
    )
  }
  log(p(C.dim, '  colunas: risco | dificuldade | modelo que o worker usará'))

  reconciliarEstados(store)
  log(`\n${p(C.dim, 'Rode "orq run" para despachar.')}`)
}

/* ---------------------------------------------------------------- status */

async function cmdStatus() {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)
  const tasks = store.listar()
  if (!tasks.length) {
    log(p(C.dim, 'Nenhuma task.'))
    return
  }

  const porEstado = {}
  for (const t of tasks) (porEstado[t.estado] ||= []).push(t)

  log(p(C.bold, `\n${tasks.length} task(s)\n`))
  for (const estado of ['em-andamento', 'aguardando-revisao', 'aguardando-integracao', 'pronta', 'aguardando-dependencia', 'bloqueada', 'pendente', 'concluida', 'falhou']) {
    const lista = porEstado[estado]
    if (!lista?.length) continue
    const cor = estado === 'falhou' ? C.red : estado === 'concluida' ? C.green : estado === 'bloqueada' ? C.yellow : C.cyan
    log(p(cor, `  ${estado} (${lista.length})`))
    for (const t of lista) {
      const extra = t.branch ? p(C.dim, ` ${t.branch}`) : ''
      log(`    ${t.id} ${t.titulo.slice(0, 50)}${extra}`)
    }
  }

  const ativas = tasks.filter((t) => t.estado === 'em-andamento')
  if (ativas.length) {
    log(p(C.bold, '\nEm execução agora:'))
    for (const t of ativas) {
      // Modelo e dificuldade entram aqui porque o sintoma clássico de "a task
      // travou" é não saber qual modelo estava atendendo: uma sessão parada sem
      // modelo visível é indistinguível de provider travado.
      const modelo = t.modelo || p(C.dim, 'default do servidor')
      log(`  ${t.id}  sessão ${p(C.dim, t.sessionID || '?')}  ${p(C.dim, `modelo ${modelo}`)}`)
      log(`         ${p(C.dim, `dificuldade ${t.dificuldade || '?'}${t.diffScore !== undefined ? ` (${t.diffScore})` : ''}`)}${t.worktree ? `  worktree ${p(C.dim, t.worktree)}` : ''}`)
    }
  }
}

/* ---------------------------------------------------------------- review */

async function cmdReview(flags, pos) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)

  const id = pos[0] || (flags.todos ? null : null)
  const alvos = id ? [id] : store.porEstado('aguardando-revisao').map((t) => t.id)
  if (!alvos.length) {
    log(p(C.dim, 'Nada para revisar.'))
    return
  }

for (const tid of alvos) {
    const task = store.obter(tid)
    if (!task) {
      erro(`Task ${tid} não existe.`)
      continue
    }

    // Revisar task em estado que não espera revisão não é erro do revisor: é o
    // estado que mudou. Sem esta checagem o `mudarEstado` lá embaixo estoura
    // "Transição inválida" e a pessoa não descobre que pediu a revisão de algo
    // já reprovado antes.
    if (!['aguardando-revisao', 'bloqueada'].includes(task.estado)) {
      erro(`${tid} está em "${task.estado}" e não espera revisão.`)
      erro('  Revisão é do que o agente entregou. Para refazer: orq run.')
      continue
    }

    // `bloqueada -> aguardando-integracao` é transição inválida de propósito:
    // nada pode pular a revisão. Mas re-revisar uma task reprovada é legítimo,
    // então ela volta pelo caminho normal antes de ser julgada de novo.
    if (task.estado === 'bloqueada') {
      store.mudarEstado(task.id, 'aguardando-revisao', {}, 'Revisão repetida')
      log(p(C.dim, `  ${task.id} estava bloqueada — voltou para aguardando-revisao.`))
    }

    const comps = componentesDaTask(cfg, task)
    const gates = []
    for (const c of comps) gates.push(...(cfg.componentes[c]?.gates || []))

    log(p(C.bold, `\n=== ${task.id} — ${task.titulo} ===`))
    const r = revisar({ task, gates })
    const crit = avaliarCriterios({ task, revisaoMecanica: r, textoAgente: task.resultado?.texto || '' })

    log(`commits: ${r.evidencia.commits?.length || 0} | arquivos: ${r.evidencia.totalArquivos || 0}`)
    if (r.evidencia.diffStat) log(p(C.dim, r.evidencia.diffStat))

    for (const g of r.gates) {
      const marca = g.pulado ? p(C.dim, '○') : g.ok ? p(C.green, '✓') : p(C.red, '✗')
      log(`  ${marca} ${g.nome}: ${g.pulado ? g.motivo : `exit ${g.exitCode} (${(g.duracaoMs / 1000).toFixed(1)}s)`}`)
      if (!g.ok && !g.pulado) log(p(C.dim, '      ' + (g.stderr || g.stdout).trim().split('\n').slice(-3).join('\n      ')))
    }

    if (crit.avaliados.length) {
      log(p(C.bold, '\n  Critérios de aceitação:'))
      for (const a of crit.avaliados) {
        const m = a.evidenciado ? p(C.green, '✓') : p(C.yellow, '?')
        log(`    ${m} ${a.criterio}  ${C.dim}(cobertura ${(a.cobertura * 100).toFixed(0)}%)${C.reset}`)
      }
      if (crit.nota) log(p(C.dim, `    ${crit.nota}`))
    }

    if (r.avisos?.length) {
      log(p(C.bold, '\n  Avisos:'))
      for (const a of r.avisos) log(`    ${p(C.yellow, '⚠')} ${a}`)
    }

    // Critérios de aceitação são texto; gates são evidência. Reprovar por
    // cobertura textual é reprovar por procurar palavra: aqui os três gates
    // estavam verdes (a suíte inteira passando) e a task foi reprovada porque
    // o critério "a suíte volta a npm test verde" não/share as palavras dos
    // commits. Heurística de texto é aviso, nunca reprovação — a nota do
    // próprio avaliarCriterios já dizia isso, e o código não cumpria.
    const aprovado = r.aprovado
    const criteriosEmAlerta = crit.avaliados.length > 0 && !crit.todosAtendidos

    log('')
    if (aprovado) {
      if (criteriosEmAlerta) {
        log(p(C.yellow, `  ⚠ APROVADA com ressalva — ${tid}`))
        log(p(C.dim, '    Evidência mecânica (gates) passou. Os critérios acima não têm cobertura textual.'))
        log(p(C.dim, '    Confira na revisão se eles são de fato satisfeitos.'))
      } else {
        log(p(C.green, `  ✓ APROVADA — ${tid} vai para aguardando-integracao`))
      }
      if (!flags['sem-aprovar']) {
        store.mudarEstado(tid, 'aguardando-integracao', { revisao: { ...r, criterios: crit, aprovadoEm: new Date().toISOString() } }, 'Revisão aprovada')
      }
    } else {
      log(p(C.red, `  ✗ REPROVADA — ${tid}`))
      for (const c of r.criticos) log(p(C.red, `      ${c}`))
      if (!flags['sem-aprovar']) {
        store.mudarEstado(tid, 'bloqueada', { revisao: { ...r, criterios: crit } }, 'Revisão reprovada')
      }
    }
  }
}

/* ------------------------------------------------------------------- run */

async function cmdRun(flags) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)
  const max = Number(flags.max || flags.concurrency || cfg.concurrency)

  reconciliarEstados(store)

  const { despachaveis } = selecionarDespachaveis({ tasks: store.listar(), concurrency: max })
  if (!despachaveis.length) {
    const pendentes = store.ativas().filter((t) => ['pendente', 'aguardando-dependencia', 'bloqueada'].includes(t.estado))
    log(p(C.dim, 'Nada despachável agora.'))
    if (pendentes.length) {
      log(`\n${pendentes.length} task(s) esperando:`)
      for (const t of pendentes) {
        const m = motivoBloqueio(t, store.ativas())
        log(`  ${t.id} ${t.titulo.slice(0, 46)}${m ? p(C.dim, `  ${m.mensagem}`) : ''}`)
      }
    }
    return
  }

  log(p(C.bold, `Despachando ${despachaveis.length} task(s), concorrência ${max}\n`))

  // Um servidor para todas as tasks desta rodada.
  const server = new OpencodeServer({ port: cfg.opencode.port, host: cfg.opencode.host, stateDir: cfg.stateDir, logDir: cfg.logDir })
  await server.garantir()
  const client = new OpencodeClient(cfg.opencode)

  for (const task of despachaveis) {
    store.mudarEstado(task.id, 'em-andamento', {}, `Despachada (rodada ${new Date().toISOString()})`)
    log(`${p(C.blue, '▶')} ${task.id} ${task.titulo}`)
  }
  log('')

  // Roda em paralelo de verdade; o teto já foi aplicado na seleção.
  const registros = await Promise.all(
    despachaveis.map((task) =>
      executarTask({
        cfg,
        store,
        task,
        client,
        log: (m) => log(p(C.dim, `  ${m}`)),
      }).catch((err) => ({ taskId: task.id, ok: false, erro: err.message })),
    ),
  )

  log(p(C.bold, '\nResultado da rodada:'))
  for (const r of registros) {
    const t = store.obter(r.taskId)
    const marca = r.ok ? p(C.green, '✓') : p(C.red, '✗')
    log(`  ${marca} ${r.taskId}  estado: ${p(C.cyan, t?.estado)}${r.erro ? `  ${p(C.red, r.erro)}` : ''}`)
  }

  const paraRevisao = store.porEstado('aguardando-revisao').map((t) => t.id)
  if (paraRevisao.length) {
    log(`\n${p(C.bold, 'Revisão pendente:')} ${paraRevisao.join(', ')}`)
    log(p(C.dim, 'Rode: orq review --todos'))
  }

  if (flags['revisar'] && paraRevisao.length) await cmdReview([], { todos: true })
}

/* -------------------------------------------------------------- integrate */

async function cmdIntegrate(flags, pos) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)

  let tasks = store.porEstado('aguardando-integracao')
  if (flags.id) tasks = tasks.filter((t) => flags.id === t.id || flags.id === t.id.toLowerCase())
  if (!tasks.length) {
    log(p(C.dim, 'Nenhuma task aguardando integração.'))
    return
  }

  // Agrupar por repo: task de componente diferente não integra junto.
  const porRepo = new Map()
  for (const t of tasks) {
    const comps = componentesDaTask(cfg, t)
    const repo = repoDoComponente(cfg, comps[0])
    if (!porRepo.has(repo)) porRepo.set(repo, [])
    porRepo.get(repo).push(t)
  }

  for (const [repo, lista] of porRepo) {
    log(p(C.bold, `\n=== Integração em ${repo} ===`))
    log(`tasks: ${lista.map((t) => t.id).join(', ')}`)
    log(`ordem: ${planner.ordenarTopologicamente(lista).map((t) => t.id).join(' → ')}\n`)

    const rel = integrar({ cfg, tasks: lista, repo, nome: repo.split(/[\\/]/).pop(), log })

    for (const c of rel.conflitos) {
      log(`  ${p(C.yellow, '⚠')} conflito previsto ${c.a} × ${c.b}: ${c.arquivos.slice(0, 4).join(', ')}`)
    }
    for (const r of rel.resultados) {
      const marca = r.ok ? p(C.green, '✓') : p(C.red, '✗')
      const sufixo = r.jaIntegrada ? p(C.dim, ' (já integrada nesta rodada anterior)') : ''
      log(`  ${marca} ${r.taskId}${r.erro ? `  ${r.erro}` : ''}${sufixo}`)
    }
    for (const g of rel.gates) {
      log(`     ${g.ok ? p(C.green, '✓') : p(C.red, '✗')} ${g.cmd} (${(g.duracaoMs / 1000).toFixed(1)}s)`)
    }

    // O ambiente do worktree de integração é o mesmo do runner: junction por
    // pacote, dependência `file:` relinkada PARA DENTRO do worktree e build dos
    // pacotes locais. Sem o build, o gate lia o `dist` do contrato de outra
    // árvore e aprovava uma mudança de contrato que nunca tinha sido compilada.
    for (const pr of rel.integracao?.ambiente?.problemas || []) {
      log(`  ${p(C.yellow, '⚠')} ambiente: ${pr}`)
    }

    log('')
    if (rel.bloqueios.length) {
      log(p(C.red, '  Bloqueios:'))
      for (const b of rel.bloqueios) log(p(C.red, `    - ${b}`))
    }

    if (rel.aprovado) {
      log(p(C.green, `\n  ✓ Integração pronta em ${rel.branchIntegracao}`))
      log(p(C.dim, `    ${rel.commits.length} commit(s) de integração`))
      log(`\n${p(C.yellow, '  NÃO houve merge na branch principal nem push.')}`)
      if (flags.aplicar) {
        log(p(C.bold, '\n  Aplicando na branch principal (--aplicar)...'))
        const aplicado = aplicarNaPrincipal({
          repo,
          // O HEAD do worktree de integração: o RESULTADO. `baseSha` é de onde a
          // integração partiu — usá-lo faz o fast-forward não mover nada e ainda
          // reportar "main: X → X" como sucesso, que foi o que acontecia.
          commitIntegracao: git.revParse('HEAD', rel.integracao.worktree),
          branchIntegracao: rel.branchIntegracao,
          baseSha: rel.integracao.baseSha,
          branchPrincipal: rel.integracao.branchPrincipal,
        })
        log(p(C.green, `  ✓ ${aplicado.branchPrincipal}: ${aplicado.antes.slice(0, 7)} → ${aplicado.depois.slice(0, 7)}`))
        log(p(C.dim, '  Ainda sem push. Use git push quando você decidir.'))
        for (const t of lista) {
          store.mudarEstado(t.id, 'concluida', { integradaEm: new Date().toISOString() }, 'Integrada na branch principal')
        }
      } else {
        for (const t of lista) {
          store.atualizar(t.id, { branchIntegracao: rel.branchIntegracao }, 'integracao-pronta')
        }
        log(p(C.dim, `\n  Para aplicar: orq integrate --aplicar ${p(C.bold, `--id ${lista[0].id}`)}`))
      }
    }
  }
}

/* ------------------------------------------------------------------- dep */

/**
 * Corrige dependências na mão.
 *
 * O planner deduz dependência por palavra-chave e às vezes acerta mal. Quem
 * decide a ordem final é a pessoa — por isso existe este comando, para não
 * obrigar ninguém a editar o .state/tasks.json na mão.
 */
async function cmdDep(flags, pos) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)
  const id = pos[0]
  if (!id) {
    erro('Uso: orq dep <ID> --add T-002 | --rm T-002')
    process.exit(1)
  }
  const task = store.obter(id)
  if (!task) {
    erro(`Task ${id} não existe.`)
    process.exit(1)
  }

  const alvo = flags.add || flags.rm
  if (!alvo) {
    log(`${p(C.bold, id)} depende de: ${(task.dependsOn || []).join(', ') || '(nada)'}`)
    return
  }

  const atual = task.dependsOn || []
  let novos
  if (flags.add) {
    if (atual.includes(alvo)) {
      log(p(C.dim, `${id} já dependia de ${alvo}.`))
      return
    }
    if (!store.obter(alvo)) {
      erro(`Task ${alvo} não existe.`)
      process.exit(1)
    }
    novos = [...atual, alvo]
  } else {
    if (!atual.includes(alvo)) {
      log(p(C.dim, `${id} não dependia de ${alvo}.`))
      return
    }
    novos = atual.filter((d) => d !== alvo)
  }

  store.atualizar(id, { dependsOn: novos }, 'dependencia-ajustada', { alvo, remover: Boolean(flags.rm) })
  log(p(C.green, `✓ ${id} agora depende de: ${novos.join(', ') || '(nada)'}`))

  reconciliarEstados(store)
  const m = motivoBloqueio(task, store.ativas())
  if (m) log(p(C.dim, `  ${m.mensagem}`))
}

/* ---------------------------------------------------------------- recover */

async function cmdRecover() {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)
  log(p(C.bold, '\nRecuperando estado...\n'))

  const mudancas = reconciliarEstados(store)
  if (mudancas.length) {
    log(p(C.cyan, 'Estados reconciliados:'))
    for (const m of mudancas) log(`  ${m.id}: ${m.de} → ${p(C.bold, m.para)}${m.motivo ? p(C.dim, ` (${m.motivo})`) : ''}`)
  } else {
    log(p(C.dim, 'Nenhum estado precisou mudar.'))
  }

  // Task em-andamento mas sem worktree válido = execução morreu no meio.
  const orfas = store.porEstado('em-andamento')
  let recuperadas = 0
  for (const t of orfas) {
    const wtOk = t.worktree && existsSync(t.worktree)
    if (!wtOk) {
      log(p(C.yellow, `\n  ${t.id}: worktree sumiu (${t.worktree || 'sem worktree'}). Marcando bloqueada.`))
      store.mudarEstado(t.id, 'bloqueada', {}, 'Recuperação: worktree não existe')
      recuperadas++
    } else {
      const temSessao = Boolean(t.sessionID)
      log(p(C.dim, `  ${t.id}: worktree intacto${temSessao ? `, sessão ${t.sessionID}` : ', sem sessão (execução provavelmente não iniciou)'}`))
      if (!temSessao) {
        store.mudarEstado(t.id, 'bloqueada', {}, 'Recuperação: execução não chegou a criar sessão')
        recuperadas++
      }
    }
  }

  log('')
  if (recuperadas) log(`${recuperadas} task(s) movida(s) para bloqueada.\n`)
  log('Revise as bloqueadas com "orq status" e "orq run".\n')
}

/**
 * Reanexa tasks que ficaram `em-andamento` porque o orquestrador morreu.
 *
 * O `recover` reconcilia estado; este volta na sessão. O agente que ficou
 * working no servidor não é reiniciado — reanexar é esperar o turno atual
 * acabar e então commitar e revisar, que é o que o orquestrador morreu fazendo.
 */
async function cmdResume(flags) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)

  let alvos = store.porEstado('em-andamento')
  if (flags.id) alvos = alvos.filter((t) => t.id === flags.id)

  if (!alvos.length) {
    log(p(C.dim, 'Nenhuma task em-andamento para reanexar.'))
    return
  }

  const server = new OpencodeServer({ port: cfg.opencode.port, host: cfg.opencode.host, stateDir: cfg.stateDir, logDir: cfg.logDir })
  await server.garantir()
  const client = new OpencodeClient({ port: cfg.opencode.port, host: cfg.opencode.host })

log(p(C.bold, `\nReanexando ${alvos.length} task(s)\n`))

  // Em paralelo, e não em sequência: uma task presa dentro de `npm run build`
  // segura as outras por horas se a espera for serial. `orq run` já despacha
  // em paralelo; reanexar faz o mesmo pelo mesmo motivo.
  const resultados = await Promise.all(
    alvos.map(async (t) => {
      if (!t.sessionID) {
        log(p(C.yellow, `  ${t.id}: sem sessão — não há o que reanexar`))
        return { id: t.id, registro: { erro: 'sem sessão' } }
      }
      const registro = await reanexarTask({ cfg, store, task: t, client, log: (m) => log(p(C.dim, m)) })
      return { id: t.id, registro, titulo: t.titulo }
    }),
  )

  for (const { id, registro, titulo } of resultados) {
    log(
      registro.ok
        ? p(C.green, `  ✓ ${id} — ${titulo}`)
        : p(C.red, `  ✗ ${id} — ${registro.erro}`),
    )
  }
  log('\nRode "orq status" e depois "orq review --todos".\n')
}

/* ----------------------------------------------------------------- adopt */

/**
 * Adota trabalho que o agente produziu mas que o orquestrador não chegou a
 * registrar.
 *
 * O caso: `opencode serve` é solto, então ele continua executando o agente
 * depois que o `orq run` morre (Ctrl+C, queda de conexão, queda da máquina). O
 * agente termina e commita normalmente — e o orquestrador, que era quem deveria
 * anotar isso, já não existe. Sem este comando, esse trabalho só aparecia como
 * "task bloqueada" e a pessoa tinha adivinhar que o commit estava lá.
 *
 * Não inventa nada: lê os commits que realmente existem na branch e só avança
 * a task se houver pelo menos um.
 */
async function cmdAdopt(flags, pos) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)

  const id = pos[0]
  if (!id) {
    erro('Informe a task: orq adopt T-003')
    process.exit(1)
  }
  const task = store.obter(id)
  if (!task) {
    erro(`Task ${id} não existe.`)
    process.exit(1)
  }
  if (!task.worktree || !existsSync(task.worktree)) {
    erro(`${id}: worktree não existe (${task.worktree || 'sem worktree'}). Nada para adotar.`)
    process.exit(1)
  }

  const base = task.baseSha || git.revParse(task.baseRef || 'HEAD', task.worktree)
  const commits = git.commitsDesde(task.worktree, base)

  log(p(C.bold, `\n=== ${id} — adotando trabalho existente ===\n`))
  log(`worktree: ${task.worktree}`)
  log(`branch:   ${task.branch || '(sem branch)'}`)
  log(`base:     ${base.slice(0, 7)}`)
  log(`commits:  ${commits.length}`)

  if (!commits.length) {
    log('')
    log(p(C.yellow, `  Nenhum commit desde a base.`))
    log(p(C.dim, '  Esta task não produziu trabalho recuperável. Use "orq run" para executá-la.'))
    return
  }
  for (const c of commits) log(p(C.dim, `  ${c.sha.slice(0, 7)} ${c.mensagem}`))

  // Trabalho pela metade: o agente pode ter morrido antes de commitar.
  let commitForcado = null
  if (!git.arvoreLimpa(task.worktree)) {
    const sujos = git.arquivosNaoCommitados(task.worktree)
    if (flags['sem-commit']) {
      log('')
      log(p(C.yellow, `  ${sujos.length} arquivo(s) sem commit, mantidos como estão (--sem-commit).`))
    } else {
      const msg =
        `feat(${id}): ${task.titulo}\n\nTask: ${id}\n` +
        `Commitado pelo "orq adopt": o agente deixou trabalho sem commit.`
      commitForcado = git.commitar(task.worktree, msg)
      log('')
      log(p(C.yellow, `  ${sujos.length} arquivo(s) sem commit → commit forçado (--sem-commit para não commitar).`))
    }
  }

  const commitsFinal = git.commitsDesde(task.worktree, base)
  const arquivos = git.arquivosCommitados(task.worktree, base)

  // Recupera o resumo que o agente escreveu, se o servidor ainda estiver no ar.
  let texto = task.resultado?.texto || ''
  let resumoOrigem = 'estado anterior'
  if (!texto && task.sessionID && !flags['sem-resumo']) {
    try {
      const client = new OpencodeClient(cfg.opencode)
      texto = await client.ultimoTextoDoAgente(task.sessionID, task.worktree)
      if (texto) resumoOrigem = `sessão ${task.sessionID}`
    } catch (err) {
      log(p(C.dim, `  (não foi possível ler a sessão: ${err.message})`))
    }
  }

  const patch = {
    commits: commitsFinal,
    arquivosAlterados: arquivos,
    erros: [],
    resultado: {
      resumo: primeiroBlocoTexto(texto, 'Resumo'),
      texto,
      adotada: true,
      commitForcado: Boolean(commitForcado),
      resumoOrigem,
    },
  }

  store.mudarEstado(id, 'aguardando-revisao', patch, `Trabalho adotado (${commitsFinal.length} commit(s))`)

  log('')
  log(p(C.green, `  ✓ ${id} → aguardando-revisao`))
  log(p(C.dim, `    resumo recuperado de: ${resumoOrigem}`))
  log(p(C.dim, `    próxima etapa: orq review ${id}`))
  log('')
}

/** Primeira seção markdown com o nome pedido; cai no texto inteiro. */
function primeiroBlocoTexto(texto, secao) {
  if (!texto) return ''
  const re = new RegExp(`###\\s*${secao}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, 'i')
  const m = texto.match(re)
  return m ? m[1].trim().slice(0, 2000) : texto.slice(0, 1000)
}

/* ------------------------------------------------------------------ clean */

async function cmdClean(flags, pos) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)
  const id = pos[0]
  if (!id) {
    erro('Informe a task: orq clean T-001 [--worktree]')
    process.exit(1)
  }
  const task = store.obter(id)
  if (!task) {
    erro(`Task ${id} não existe.`)
    process.exit(1)
  }

  if (!flags['worktree']) {
    store.remover(id)
    log(p(C.green, `✓ ${id} removida do estado. (branch/worktree intactos)`))
    return
  }

  // Guardar o estado mas descartar o worktree é o caso do agente que morreu no
  // meio: o runner recusa reexecutar enquanto o diretório existir, e apagar a
  // task junto com ele jogaria fora o título, o escopo e os critérios — tudo
  // que a pessoa escreveu à mão e que não se reconstrói sozinho.
  if (task.branch) {
    try {
      const repo = git.commonDir(task.worktree)
      // A junction de node_modules criada por prepararAmbiente segura o
      // diretório: o `git worktree remove` limpa o conteúdo mas devolve o
      // worktree como pasta vazia, e a próxima execução morre em "worktree já
      // existe". Tira a junction antes.
      //
      // E o que NÃO conseguiu tirar é reportado: a versão anterior engolia o
      // erro e a mensagem seguinte era sobre o diretório, mandando a pessoa
      // procurar o problema no lugar errado.
      const limpeza = limparAmbiente(task.worktree, repo)
      if (limpeza.falhas?.length) {
        log(p(C.yellow, `  ⚠ ${limpeza.falhas.length} junction(s) não removida(s): ${limpeza.falhas.join('; ')}`))
      }
      git.removerWorktree(repo, task.worktree, { forcar: true })
      if (git.branchExists(task.branch, repo)) {
        git.run(['branch', '-D', task.branch], { cwd: repo, allowDestructive: true })
      }
      log(p(C.green, `✓ worktree e branch ${task.branch} removidos`))
    } catch (err) {
      erro(`Falha ao limpar: ${err.message}`)
    }
  }
  // Sobra de remoção anterior: diretório vazio que o git não leva junto.
  if (task.worktree && existsSync(task.worktree) && !readdirSync(task.worktree).length) {
    try {
      rmSync(task.worktree, { recursive: true, force: true })
      rmSync(dirname(task.worktree), { recursive: true, force: true })
    } catch {}
  }

  if (flags['manter']) {
    store.atualizar(id, { branch: null, worktree: null, sessionID: null, baseSha: null, baseRef: null }, 'worktree-descartado', {
      motivo: 'worktree e branch removidos; task mantida para reexecução',
    })
    store.mudarEstado(id, 'pronta', { erros: [] }, 'Pronta para reexecução (worktree descartado)')
    log(p(C.green, `✓ ${id} mantida no estado e pronta para rodar de novo`))
    return
  }

  store.remover(id)
}

/* --------------------------------------------------------- trello / agents */

async function cmdTrelloSync(flags) {
  const cfg = await carregarConfig()
  const store = storeDe(cfg)
  const boardId = flags.board || process.env.TRELLO_BOARD_ID || cfg.trello.boardId
  const componentesValidos = Object.keys(cfg.componentes)

  log(p(C.bold, '\nImportando do Trello...\n'))
  let resultado
  try {
    resultado = await trello.importar({ boardId, listas: flags.listas || null, componentesValidos })
  } catch (err) {
    erro(trello.ocultar(err.message))
    process.exit(1)
  }

  log(`board: ${resultado.board.nome}`)
  log(`listas: ${resultado.listas.join(', ')}`)
  log(`cards: ${resultado.tarefas.length}\n`)

  for (const c of resultado.tarefas) {
    const t = store.criar({
      id: c.idExterno ? undefined : undefined,
      titulo: c.titulo,
      descricao: c.descricao,
      origem: c.origem,
      componentes: c.componentes,
      dependsOn: c.dependsOn,
      prioridade: c.prioridade,
      checklists: c.checklists,
    })
    log(`  ${p(C.green, '+')} ${t.id} ${t.titulo.slice(0, 55)}${c.componentes.length ? p(C.dim, ` [${c.componentes.join(',')}]`) : ''}`)
  }
  log(`\n${p(C.dim, 'Rode "orq plan" para decompor checklists e deduzir dependências.')}`)
}

async function cmdInstallAgents() {
  const cfg = await carregarConfig()
  const destino = join(process.env.USERPROFILE || process.env.HOME, '.config', 'opencode', 'agent')
  const { mkdirSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs')
  mkdirSync(destino, { recursive: true })
  const dirFonte = join(cfg.raiz, 'agents')
  const arquivos = readdirSync(dirFonte).filter((f) => f.endsWith('.md'))
  if (!arquivos.length) {
    log(p(C.yellow, 'Nenhum agente em agents/.'))
    return
  }
  for (const f of arquivos) {
    writeFileSync(join(destino, f), readFileSync(join(dirFonte, f), 'utf8'))
    log(p(C.green, '✓ ') + f)
  }
  log(`\nInstalados em ${destino}`)
  log(p(C.dim, 'Agentes globais: valem para qualquer repo. Para limitar ao portal, copie em portal/.opencode/agent/.'))
}

/**
 * `orq sync-mcp` — delega ao tools/sync-mcp.mjs.
 *
 * Fica num script separado, e nao inline aqui, porque o arquivo faz parse de
 * JSONC com tolerancia a comentario: essa logica tem teste proprio e nao deve
 * nascer dentro de um arquivo que ja tem 900 linhas.
 */
async function cmdSyncMcp() {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const script = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tools', 'sync-mcp.mjs')
  const r = spawnSync(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' })
  if (r.status) process.exit(r.status ?? 1)
}

/* ------------------------------------------------------------------ main */

const COMANDOS = {
  init: cmdInit,
  add: cmdAdd,
  plan: cmdPlan,
  run: cmdRun,
  status: cmdStatus,
  review: cmdReview,
  integrate: cmdIntegrate,
  dep: cmdDep,
  recover: cmdRecover,
  resume: cmdResume,
  adopt: cmdAdopt,
  clean: cmdClean,
  'trello-sync': cmdTrelloSync,
  'install-agents': cmdInstallAgents,
  'sync-mcp': cmdSyncMcp,
}

async function main() {
  const [comando, ...resto] = process.argv.slice(2)
  if (!comando || comando === '--help' || comando === '-h' || !COMANDOS[comando]) {
    log(`
${p(C.bold, 'orq')} — orquestrador multiagente para OpenCode

${p(C.bold, 'Comandos:')}
  init               verifica ambiente, componentes e agentes
  add "<texto>"      cria task  (--comp --crit --dep --arq --prio)
  plan               decompõe, deduz dependências, prever conflitos
  run                despacha a fila  (--max N --revisar)
  status             estado de tudo
  review             revisa aprovadas  (--todos --sem-aprovar)
  integrate          integra aprovadas  (--id X --aplicar)
  dep <id>           ajusta dependencia  (--add T-002 | --rm T-002)
  recover            reidrata estado após reinício
  adopt <id>         adota commits já feitos por um agente órfão
  clean <id>         remove do estado  (--worktree também apaga branch; --manter preserva a task)
  trello-sync        importa cards  (--board ID --listas "A,B")
  install-agents     instala os agentes orq-*
  sync-mcp           escreve os MCPs do config em ~/.config/opencode/opencode.jsonc  (--dry-run)

${p(C.bold, 'Fluxo típico:')}
  orq init
  orq add "..." --comp portal --crit "..." && orq plan && orq run
  orq review --todos
  orq integrate --aplicar
`)
    process.exit(comando ? 0 : 1)
  }

  const { pos, flags } = parseArgs(resto)
  try {
    await COMANDOS[comando](flags, pos)
  } catch (err) {
    erro('\n✗ ' + (err.message || err))
    if (flags.debug) erro(err.stack)
    process.exit(1)
  }
}

main()
