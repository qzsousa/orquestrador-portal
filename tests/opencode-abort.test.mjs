/**
 * Testes do abort: o runner precisa PARAR o agente, não só parar de esperar.
 *
 * A propriedade é do lado do cliente HTTP, então ela é testada com um `fetch`
 * falso que registra o que foi chamado. Sem abort, o agente continuava
 * escrevendo no worktree depois de a task mudar de estado — e o commit de
 * rescue do timeout trazia esse trabalho junto, como se fosse intencional.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { OpencodeClient, OpencodeError } from '../src/core/opencode.mjs'

/** Resposta JSON mínima, no formato que o cliente espera. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/**
 * Cliente com histórico de chamadas e respostas agendadas.
 *
 * `mensagens` é uma função: cada chamada de `/message` devolve o próximo item,
 * o que permite simular "ainda não terminou" quantas vezes for preciso.
 */
function clienteFalso({ mensagens, diretorio }) {
  const chamadas = []
  const fetchImpl = async (url, opcoes) => {
    const u = new URL(url)
    chamadas.push({ metodo: opcoes.method, caminho: u.pathname })

    if (u.pathname.endsWith('/prompt_async')) return jsonResponse({}, { status: 204 })
    if (u.pathname.endsWith('/abort')) return jsonResponse({})
    if (u.pathname.endsWith('/message')) return jsonResponse(mensagens())
    throw new Error(`chamada inesperada: ${opcoes.method} ${u.pathname}`)
  }
  return { client: new OpencodeClient({ fetchImpl }), chamadas }
}

const CONCLUIDA = { info: { id: 'm1', role: 'assistant', time: { completed: 1700000000000 } }, parts: [] }
const EM_ANDAMENTO = { info: { id: 'm1', role: 'assistant', time: {} }, parts: [] }

describe('enviarPrompt — cancelamento', () => {
  test('chama /abort quando cancelado() vira verdadeiro', async () => {
    let respostas = 0
    const { client, chamadas } = clienteFalso({
      mensagens: () => {
        respostas += 1
        return respostas <= 2 ? [EM_ANDAMENTO] : [CONCLUIDA]
      },
    })

    let cancelado = false
    await assert.rejects(
      () =>
        client.enviarPrompt({
          sessionID: 'ses_1',
          texto: 'briefing',
          intervaloMs: 1,
          cancelado: () => {
            // Só cancela depois de duas voltas: prova que o laço consultou.
            cancelado = respostas >= 2
            return cancelado
          },
        }),
      (err) => {
        assert.ok(err instanceof OpencodeError)
        assert.equal(err.status, 'cancelado')
        return true
      },
    )

    assert.ok(
      chamadas.some((c) => c.caminho.endsWith('/abort')),
      `esperava uma chamada a /abort; viu: ${chamadas.map((c) => c.caminho).join(', ')}`,
    )
  })

  test('o abort acontece ANTES de consultar mensagens do turno', () => {
    // Ordem importa: se consultasse mensagens primeiro, o turno ainda estaria
    // rodando no servidor quando o laço desistisse — e uma consulta é um ciclo
    // de rede inteiro desperdiçado num turno que já foi abandonado.
    const { client, chamadas } = clienteFalso({ mensagens: () => [EM_ANDAMENTO] })

    return client
      .enviarPrompt({
        sessionID: 'ses_1',
        texto: 'briefing',
        intervaloMs: 1,
        cancelado: () => true,
      })
      .then(() => assert.fail('deveria ter rejeitado'))
      .catch((err) => {
        assert.equal(err.status, 'cancelado')
        assert.deepEqual(
          chamadas.map((c) => c.caminho),
          ['/session/ses_1/prompt_async', '/session/ses_1/abort'],
        )
      })
  })

  test('sem cancelamento, o turno segue até time.completed', async () => {
    let respostas = 0
    const { client, chamadas } = clienteFalso({
      mensagens: () => {
        respostas += 1
        return respostas <= 3 ? [EM_ANDAMENTO] : [CONCLUIDA]
      },
    })

    const r = await client.enviarPrompt({ sessionID: 'ses_1', texto: 'b', intervaloMs: 1 })

    assert.equal(r.info.id, 'm1')
    assert.equal(
      chamadas.some((c) => c.caminho.endsWith('/abort')),
      false,
      'não deveria abortar um turno que vai terminar',
    )
  })

  test('cancelar é opcional: sem a função, o comportamento é o de sempre', async () => {
    const { client, chamadas } = clienteFalso({ mensagens: () => [CONCLUIDA] })
    const r = await client.enviarPrompt({ sessionID: 'ses_1', texto: 'b', intervaloMs: 1 })

    assert.equal(r.info.id, 'm1')
    assert.equal(chamadas.some((c) => c.caminho.endsWith('/abort')), false)
  })
})

describe('enviarPromptAguardar — cancelamento', () => {
  test('desiste sem esperar o turno terminar', async () => {
    const { client, chamadas } = clienteFalso({ mensagens: () => [EM_ANDAMENTO] })

    await assert.rejects(
      () =>
        client.enviarPromptAguardar({
          sessionID: 'ses_1',
          intervaloMs: 1,
          cancelado: () => true,
        }),
      (err) => {
        assert.equal(err.status, 'cancelado')
        return true
      },
    )

    // A reanexação só ESPERA: ela não despacha nada, então abortar aqui seria
    // matar o trabalho de uma execução anterior que ainda pode ser aproveitado.
    assert.equal(
      chamadas.some((c) => c.caminho.endsWith('/abort')),
      false,
      'a reanexação não deve abortar a sessão de outro processo',
    )
  })
})

describe('abortar', () => {
  test('falha de abort não derruba o chamador', async () => {
    const client = new OpencodeClient({
      fetchImpl: async () => {
        throw new Error('servidor caiu')
      },
    })
    // O abort é o caminho de resgate: se ele mesmo falhar, o runner precisa
    // seguir e reportar o cancelamento, não trocar um erro por outro.
    assert.equal(await client.abortar('ses_1'), null)
  })
})
