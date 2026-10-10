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

/* ------------------------------------------ execução longa sem POST travado */

describe('esperarAgente — o agente pode levar mais de 5 minutos', () => {
  const ok = (corpo) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => corpo,
  })

  const assistant = (finish, erro) => ({ info: { role: 'assistant', finish, error: erro }, parts: [] })

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
