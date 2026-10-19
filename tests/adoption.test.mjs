/**
 * Testes da recuperação de agente órfão.
 *
 * O problema que estes testes cobrem aconteceu de verdade: o `opencode serve` é
 * solto, então ele continua executando o agente depois que o `orq run` morre. O
 * agente termina e commita; o orquestrador, que era quem anotaria isso, já foi
 * embora. O estado dizia "bloqueada / fetch failed", que é falso — não houve
 * falha de agente, houve queda de transporte.
 *
 * São duas propriedades que precisam continuar valendo:
 *   1. queda de transporte não vira "a task falhou"
 *   2. o trabalho já commitado pode ser adotado e seguir para revisão
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore, transicaoValida } from '../src/core/taskstore.mjs'
import { OpencodeClient, OpencodeError, extrairErros } from '../src/core/opencode.mjs'
import { culpaDaTask } from '../src/core/review.mjs'

function dirTemporario() {
  return mkdtempSync(join(tmpdir(), 'orq-adopt-'))
}

/* ------------------------------------------------------------ transições */

describe('adoption — máquina de estados', () => {
  test('bloqueada pode voltar para aguardando-revisao (caminho do adopt)', () => {
    assert.equal(transicaoValida('bloqueada', 'aguardando-revisao'), true)
  })

  test('o adopt só abre caminho para revisão, não pula a revisão', () => {
    // O ponto do adopt é devolver a task ao fluxo normal, não reprovar por ela.
    assert.equal(transicaoValida('bloqueada', 'aguardando-integracao'), false)
    assert.equal(transicaoValida('bloqueada', 'concluida'), false)
    assert.equal(transicaoValida('aguardando-revisao', 'concluida'), false)
  })

  test('adopt devolve a task bloqueada ao fluxo e limpa o erro antigo', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('tarefa qualquer')
    s.mudarEstado(t.id, 'bloqueada', { erros: ['fetch failed'] }, 'queda')
    s.mudarEstado(t.id, 'aguardando-revisao', { erros: [], resultado: { adotada: true } }, 'Trabalho adotado')
    const depois = s.obter(t.id)
    assert.equal(depois.estado, 'aguardando-revisao')
    assert.deepEqual(depois.erros, [])
    assert.equal(depois.resultado.adotada, true)
    rmSync(d, { recursive: true, force: true })
  })
})

/* ------------------------------------------------- classificação de erro */

describe('adoption — classificação de falha de transporte', () => {
  // Reproduz o que o undici faz quando a conexão morre: um TypeError genérico
  // cujo motivo real está escondido em .cause.
  function fetchQuebrado() {
    const err = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('socket destroyed'), { code: 'ECONNRESET' })
    return () => Promise.reject(err)
  }

  test('"fetch failed" vira erro de transporte com o código real, não texto cru', async () => {
    const client = new OpencodeClient({ fetchImpl: fetchQuebrado() })
    await assert.rejects(
      () => client.request('POST', '/session/x/message'),
      (err) => {
        assert.ok(err instanceof OpencodeError)
        assert.equal(err.status, 'transporte')
        assert.equal(err.causa, 'ECONNRESET')
        // O texto cru "fetch failed" é exatamente o que enganava quem lia o estado.
        assert.ok(!err.message.includes('fetch failed'))
        assert.match(err.message, /ECONNRESET/)
        return true
      },
    )
  })

  test('timeout continua sendo timeout, e não transporte', async () => {
    const client = new OpencodeClient({ fetchImpl: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })) })
    await assert.rejects(
      () => client.request('GET', '/global/health'),
      (err) => {
        assert.equal(err.status, 'timeout')
        return true
      },
    )
  })

  test('erro do próprio OpenCode (HTTP) passa intacto, sem ser reclassificado', async () => {
    const client = new OpencodeClient({
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'ruim' }),
    })
    await assert.rejects(
      () => client.request('POST', '/session'),
      (err) => {
        assert.equal(err.status, 400)
        assert.match(err.message, /HTTP 400/)
        return true
      },
    )
  })
})

/* ------------------------------------------------- erro no nível da mensagem */

describe('agente que nem começou a rodar', () => {
  // Resposta real de um agente barrado pelo provedor: zero parts, erro só na
  // mensagem. O orquestrador lia isso como "a task não alterou nada".
  const respostaDoProvedor = {
    info: {
      role: 'assistant',
      error: {
        name: 'APIError',
        data: {
          message: 'Validation: Unsupported parameter(s): `permissions`',
          statusCode: 400,
        },
      },
    },
    parts: [],
  }

  test('erro do provedor aparece, em vez de virar "nenhum commit produzido"', () => {
    const erros = extrairErros(respostaDoProvedor)
    assert.equal(erros.length, 1)
    assert.match(erros[0], /APIError/)
    assert.match(erros[0], /HTTP 400/)
    assert.match(erros[0], /permissions/)
  })

  test('resposta saudável não vira erro', () => {
    assert.deepEqual(extrairErros({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'pronto' }] }), [])
  })

  test('erro de tool continua sendo reportado', () => {
    const erros = extrairErros({
      info: { role: 'assistant' },
      parts: [{ type: 'tool', state: { status: 'error', error: { name: 'BashError', data: { message: 'saiu 1' } } } }],
    })
    assert.deepEqual(erros, ['saiu 1'])
  })
})

/* -------------------------------- sessão que morre sem reportar erro */

describe('diagnosticoDaSessao — "nenhum commit" não é diagnóstico', () => {
  // Sessão real que falhou três vezes: o agente lia migration, rodava grep,
  // lia schema — e a sessão parava. Sem `error` em nenhuma parte, o que fazia o
  // `extrairErros` devolver lista vazia e o orq escrever "a task não alterou
  // nada". Era mentira: o agente não decidiu nada, ele deixou de existir.
  const sessaoMorta = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'briefing' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Vou ler as migrations.' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed' } }] },
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'grep', state: { status: 'completed' } }] },
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }] },
  ]

  // O content-type importa: `request()` desvia para o parser de texto quando a
  // resposta não se declara JSON, e um mock sem header faz todo retrato virar
  // zero — que é exatamente o sintoma que estamos tentando evitar.
  const client = (msgs) =>
    new OpencodeClient({
      fetchImpl: async () =>
        new Response(JSON.stringify(msgs), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

  test('sessão que lia mas não escrevesse é marcada como morta, não como vazia', async () => {
    const r = await client(sessaoMorta).diagnosticoDaSessao('s1', '/dir')
    assert.equal(r.mensagens, 5)
    assert.equal(r.ferramentas, 3)
    assert.deepEqual(r.nomeDasFerramentas, ['read', 'grep', 'bash'])
    assert.equal(r.escreveu, false)
  })

  test('sessão que escreveu é distinguir de uma que só leu', async () => {
    const comEdicao = [...sessaoMorta, { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'edit', state: { status: 'completed' } }] }]
    const r = await client(comEdicao).diagnosticoDaSessao('s2', '/dir')
    assert.equal(r.escreveu, true, 'edit/write/patch marcam que o agente começou a produzir')
  })

  test('write e patch também contam como escrita, não só edit', async () => {
    for (const tool of ['write', 'patch']) {
      const r = await client([{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool, state: {} }] }]).diagnosticoDaSessao('s', '/dir')
      assert.equal(r.escreveu, true, `${tool} tem que contar`)
    }
  })

  test('sessão vazia não vira retrato inventado', async () => {
    const r = await client([]).diagnosticoDaSessao('s3', '/dir')
    assert.equal(r.mensagens, 0)
    assert.equal(r.ferramentas, 0)
    assert.equal(r.escreveu, false)
  })

  test('o último texto do agente fica disponível para o diagnóstico citar', async () => {
    const r = await client(sessaoMorta).diagnosticoDaSessao('s4', '/dir')
    assert.equal(r.ultimoTexto, 'Vou ler as migrations.')
  })
})

/* ------------------------------------------ execução longa sem POST travado */

describe('esperarAgente — o agente pode levar mais de 5 minutos', () => {
  const ok = (corpo) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => corpo,
  })

  const assistant = (finish, erro, extra) => ({ info: { role: 'assistant', finish, error: erro, ...extra }, parts: [] })

  test('devolve assim que a última mensagem ganha finish', async () => {
    let n = 0
    const client = new OpencodeClient({
      fetchImpl: async () => {
        n++
        // em andamento, em andamento, terminou
        return ok(n < 3 ? [assistant('')] : [assistant('stop')])
      },
    })
    const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
    assert.equal(r.info.finish, 'stop')
    assert.equal(n, 3)
  })

  // A regressão que matava as tasks: uma mensagem de assistant que chama
  // ferramenta tem `finish: "tool-calls"` e `time.completed` preenchido, e o
  // turno CONTINUA na mensagem seguinte. Ler `finish` como "terminou" fazia o
  // orquestrador retornar no primeiro tool-calls e o `finally` chamar /abort
  // com o agente no meio — o worktree ficava intocado e a task era reportada
  // como "nenhum commit", que é falso.
  test('finish "tool-calls" NAO encerra o turno: o agente continua trabalhando', async () => {
    let n = 0
    const client = new OpencodeClient({
      fetchImpl: async () => {
        n++
        // tres mensagens de tool-calls e so entao a final
        return ok(n < 4 ? [assistant('tool-calls', undefined, { time: { completed: 1 } })] : [assistant('stop')])
      },
    })
    const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
    assert.equal(r.info.finish, 'stop', 'esperou passar pelas tool-calls')
    assert.equal(n, 4, 'nao desistiu no meio do turno')
  })

  test('tool-calls com time.completed preenchido ainda nao e o fim', async () => {
    // Foi exatamente o dado observado na sessao real que morreu: `completed`
    // preenchido e `finish: "tool-calls"`.
    let n = 0
    const client = new OpencodeClient({
      fetchImpl: async () => {
        n++
        return ok(n < 2 ? [assistant('tool-calls', undefined, { time: { completed: 1792378118456 } })] : [assistant('stop')])
      },
    })
    const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
    assert.equal(r.info.finish, 'stop')
    assert.equal(n, 2)
  })

  test('finish terminal que nao seja stop tambem encerra', async () => {
    for (const f of ['length', 'content-filter', 'abort', 'other']) {
      let n = 0
      const client = new OpencodeClient({
        fetchImpl: async () => ok((n++, n < 2 ? [assistant('')] : [assistant(f)])),
      })
      const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
      assert.equal(r.info.finish, f, `${f} tem que encerrar`)
    }
  })

  // A T-006 ficou 30 minutos em "em-andamento" com um `read` que nunca voltou.
  // Nem "parou de chegar mensagem" serve de sinal — `npm test` some por minutos
  // de verdade. O que não tem como ser normal é a ferramenta continuar rodando
  // depois do timeout que ela mesma declarou.
  describe('ferramenta travada', () => {
    const agora = Date.now()
    const rodando = (tool, haMs, timeout) => ({
      parts: [{ type: 'tool', tool, state: { status: 'running', time: { start: agora - haMs }, input: timeout ? { timeout } : {} } }],
    })

    test('rodando acima do timeout declarado é travada', () => {
      const r = OpencodeClient.FERRAMENTA_TRAVADA(rodando('read', 600000, 300000), agora)
      assert.equal(r.ferramenta, 'read')
      assert.equal(r.rodandoHaMs, 600000)
    })

    test('rodando dentro do prazo não é travada', () => {
      assert.equal(OpencodeClient.FERRAMENTA_TRAVADA(rodando('bash', 60000, 300000), agora), null)
    })

    test('sem timeout declarado usa o padrão do servidor', () => {
      assert.equal(OpencodeClient.FERRAMENTA_TRAVADA(rodando('grep', 60000), agora), null, '1min não é travado')
      assert.ok(OpencodeClient.FERRAMENTA_TRAVADA(rodando('grep', 400000), agora), '6min sem timeout declarado é travado')
    })

    test('ferramenta concluída nunca é travada, por mais velha que seja', () => {
      const feita = { parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', time: { start: agora - 600000 }, input: { timeout: 300000 } } }] }
      assert.equal(OpencodeClient.FERRAMENTA_TRAVADA(feita, agora), null)
    })

    test('esperarAgente devolve a mensagem marcada quando a ferramenta trava', async () => {
      const client = new OpencodeClient({
        fetchImpl: async () =>
          ok([{ info: { role: 'assistant', finish: 'tool-calls' }, parts: [{ type: 'tool', tool: 'read', state: { status: 'running', time: { start: Date.now() - 600000 }, input: { timeout: 300000 } } }] }]),
      })
      const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
      assert.equal(r.info.error.name, 'FerramentaTravada')
      assert.match(r.info.error.data.message, /parou de progredir/)
    })
  })

  // O outro lado da sessão parada: o stream abriu (prompt_async devolveu 204),
  // existe mensagem de assistant, e ela nunca recebeu uma parte sequer. Sem
  // isto o orquestrador espera o prazo inteiro olhando para uma mensagem vazia.
  describe('turno sem produção', () => {
    const agora = Date.now()
    const vazia = (haMs, parts = []) => ({ info: { role: 'assistant', time: { created: agora - haMs } }, parts })

    test('assistant vazia há mais de 3min é turno sem produção', () => {
      const r = OpencodeClient.TURNO_SEM_PRODUCAO(vazia(600000), agora)
      assert.equal(r.minutos, 10)
    })

    test('assistant vazia há pouco ainda é o modelo pensando', () => {
      assert.equal(OpencodeClient.TURNO_SEM_PRODUCAO(vazia(30000), agora), null)
    })

    test('qualquer parte já é progresso', () => {
      assert.equal(OpencodeClient.TURNO_SEM_PRODUCAO(vazia(600000, [{ type: 'text', text: 'Vou l' }]), agora), null)
      assert.equal(
        OpencodeClient.TURNO_SEM_PRODUCAO(vazia(600000, [{ type: 'tool', tool: 'read', state: { status: 'completed' } }]), agora),
        null,
      )
    })

    test('mensagem de usuário não conta, e finish terminal não conta', () => {
      assert.equal(OpencodeClient.TURNO_SEM_PRODUCAO({ info: { role: 'user', time: { created: agora - 600000 } }, parts: [] }, agora), null)
      assert.equal(
        OpencodeClient.TURNO_SEM_PRODUCAO({ ...vazia(600000), info: { role: 'assistant', finish: 'stop', time: { created: agora - 600000 } } }, agora),
        null,
      )
    })

    test('esperarAgente devolve marcada em vez de esperar o prazo inteiro', async () => {
      const client = new OpencodeClient({
        fetchImpl: async () => ok([vazia(600000)]),
      })
      const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
      assert.equal(r.info.error.name, 'TurnoSemProducao')
      assert.match(r.info.error.data.message, /não produziu nada/)
    })
  })

  test('devolve imediatamente quando o agente reporta erro', async () => {
    const client = new OpencodeClient({
      fetchImpl: async () => ok([assistant('', { name: 'APIError', data: { message: '400', statusCode: 400 } })]),
    })
    const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1 })
    assert.equal(r.info.error.name, 'APIError')
    assert.match(extrairErros(r)[0], /HTTP 400/)
  })

  test('pico de rede no meio da espera não joga o trabalho fora', async () => {
    let n = 0
    const client = new OpencodeClient({
      fetchImpl: async () => {
        n++
        if (n <= 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
        return ok([assistant('stop')])
      },
    })
    const r = await client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1, maxFalhasConsecutivas: 5 })
    assert.equal(r.info.finish, 'stop')
    assert.equal(n, 4)
  })

  test('desiste só depois de várias falhas seguidas', async () => {
    const client = new OpencodeClient({
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
      },
    })
    await assert.rejects(
      () => client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 1, maxFalhasConsecutivas: 3 }),
      /ECONNRESET/,
    )
  })

  test('estoura o prazo e diz que o agente não terminou', async () => {
    const client = new OpencodeClient({ fetchImpl: async () => ok([assistant('')]) })
    await assert.rejects(
      () => client.esperarAgente({ sessionID: 'ses_x', intervaloMs: 5, timeoutMs: 60 }),
      (err) => {
        assert.equal(err.status, 'timeout')
        return true
      },
    )
  })

  test('enviarPrompt dispara assíncrono em vez de travar num POST longo', async () => {
    const chamadas = []
    const client = new OpencodeClient({
      fetchImpl: async (url, opts) => {
        chamadas.push(`${opts.method} ${new URL(url).pathname}`)
        if (opts.method === 'POST') return { ok: true, status: 204, headers: { get: () => '' }, text: async () => '' }
        return ok([assistant('stop')])
      },
    })
    await client.enviarPrompt({ sessionID: 'ses_x', texto: 'oi', intervaloMs: 1 })
    assert.ok(chamadas.some((c) => c.includes('prompt_async')), `chamadas: ${chamadas.join(', ')}`)
    // O GET de /message é o polling e é esperado. O que não pode existir é o
    // POST em /message, que é o que trava e estoura o headers timeout.
    const postBloqueante = chamadas.filter((c) => c.startsWith('POST') && /\/message$/.test(c))
    assert.deepEqual(postBloqueante, [], `POST bloqueante em /message: ${postBloqueante.join(', ')}`)
  })
})

/* ------------------------------------------- atribuição de falha de gate */

describe('gate — a falha tem de ser da task, não só cite o nome dela', () => {
  const arquivosDaTask = [
    'backend/src/routes/chamados.ts',
    'backend/src/routes/formulario.ts',
    'backend/src/routes/formulario.condicoes.test.ts',
  ]

  // Reproduz a saída real do vitest que reprovou a T-003: os testes dela
  // passaram, mas o nome do arquivo dela aparece na lista verde, enquanto as
  // falhas são todas de outros arquivos.
  const saida = [
    ' ✓ src/routes/formulario.condicoes.test.ts  (22 tests) 253ms',
    '',
    '⎯⎯⎯⎯⎯⎯ Failed Tests 14 ⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  src/routes/auth.test.ts > Auth Routes > POST /login >',
    ' ❯ src/routes/auth.test.ts:42:10',
    ' FAIL  src/routes/escolas.test.ts > Escolas Routes > GET / >',
    ' ❯ src/routes/escolas.test.ts:78:35',
    ' FAIL  src/routes/usuarios.test.ts > Usuários Routes (ADMIN) > PATCH',
    ' ❯ src/routes/usuarios.test.ts:344:26',
  ].join('\n')

  test('arquivo que PASSOU e está listado no resumo não atribui a falha à task', () => {
    assert.equal(culpaDaTask({ stdout: saida, stderr: '' }, arquivosDaTask), false)
  })

  test('falha que aponta para arquivo alterado pela task é bloqueante', () => {
    const quebrado = saida.replace('src/routes/auth.test.ts:42:10', 'src/routes/formulario.ts:12:5')
    assert.equal(culpaDaTask({ stdout: quebrado, stderr: '' }, arquivosDaTask), true)
  })

  test('falha no arquivo de teste criado pela task também é bloqueante', () => {
    const quebrado = saida.replace('src/routes/auth.test.ts:42:10', 'src/routes/formulario.condicoes.test.ts:9:3')
    assert.equal(culpaDaTask({ stdout: quebrado, stderr: '' }, arquivosDaTask), true)
  })

  test('cores ANSI na saída não escondem a falha', () => {
    const ansi = saida.replace('FAIL  src/routes/escolas', '[31mFAIL[39m  src/routes/escolas')
    assert.equal(culpaDaTask({ stdout: ansi, stderr: '' }, arquivosDaTask), false)
    const ansiQuebrado = ansi.replace('src/routes/auth.test.ts:42:10', 'src/routes/chamados.ts:7:1')
    assert.equal(culpaDaTask({ stdout: ansiQuebrado, stderr: '' }, arquivosDaTask), true)
  })

  test('stderr conta tanto quanto stdout', () => {
    assert.equal(culpaDaTask({ stdout: '', stderr: ' FAIL  src/routes/formulario.ts > x' }, arquivosDaTask), true)
  })

  // O gate não é sempre vitest: o E2E usa um script próprio que imprime
  // "FALTA: x.ts". Uma heurística que só entende o formato do vitest deixa
  // esses gates cegos — e gate cego reprova task inocente.
  test('gate de runner próprio ainda atribui a falha corretamente', () => {
    const meu = 'FALTA: src/funcao.ts\n'
    assert.equal(culpaDaTask({ stdout: meu, stderr: '' }, ['src/funcao.ts']), true)
    assert.equal(culpaDaTask({ stdout: meu, stderr: '' }, ['src/outro.ts']), false)
  })

  test('runner sem marcador de sucesso: tudo citado é suspeito, e isso é o lado seguro', () => {
    const saida = 'OK: src/funcao.ts\nFALTA: src/outro.ts\n'
    // Não existe marcador universal de sucesso entre runners. Um gate que só
    // imprime "FALTA: x.ts" não diz nada sobre o que passou, então não há como
    // separar os dois. Sem essa informação, a heurística acusa a task — que é
    // o erro pelo lado seguro: reprovar a mais incomoda, aprovar quebrado é
    // pior. O modo de ficar quieto é o runner falar (✓, "passed").
    assert.equal(culpaDaTask({ stdout: saida, stderr: '' }, ['src/funcao.ts']), true)
    assert.equal(culpaDaTask({ stdout: saida, stderr: '' }, ['src/outro.ts']), true)
  })
})
