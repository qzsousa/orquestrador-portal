import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { avaliarCriterios, arquivosDoCriterio, arquivosTocados } from '../src/core/review.mjs'

/**
 * Critério de aceitação costuma dizer ONDE a mudança tem que estar. A revisão
 * só contava palavra sobreposta com o relatório do agente, então um critério
 * que aponta um arquivo nunca mexeu era apenas "sem evidência textual" —
 * mesmo tom, mesmaAsterisco do resto, e passou.
 *
 * A T-003 aprovou com os 4 gates verdes e três critérios por fazer: os quatro
 * pontos de publicação (auth.ts, usuarios.ts) e o arquivo de teste. Os testes
 * antigos seguiam verdes porque ninguém escreve teste novo nesse caso. Ler o
 * diff acusou na hora.
 */
describe('arquivosDoCriterio — o caminho que o critério aponta', () => {
  test('acha caminho com diretório e extensão', () => {
    const a = arquivosDoCriterio('publicar em CAMPOS_PUBLICAVEIS, src/routes/auth.ts:72-91')
    assert.deepEqual(a, ['src/routes/auth.ts'])
  })

  test('não pega o que não é arquivo', () => {
    assert.deepEqual(arquivosDoCriterio('o schema mora em backend/prisma e nos tipos'), [])
  })

  test('ignora artefato gerado: dist, build e node_modules', () => {
    // O critério cita "dist/api.d.ts velho" para explicar erro de typecheck,
    // não para pedir que alguém edite o dist.
    assert.deepEqual(arquivosDoCriterio('sem build, o typescript le o dist/api.d.ts velho'), [])
    assert.deepEqual(arquivosDoCriterio('rode node_modules/.bin/whatever.js'), [])
  })

  test('limpa pontuação que vem da prosa', () => {
    const a = arquivosDoCriterio('copie o padrão de shared/types/api.ts (api.ts:790) e de x.vue.')
    assert.ok(a.includes('shared/types/api.ts'))
    assert.ok(a.includes('x.vue'))
  })
})

describe('arquivosTocados — normaliza o diff para comparar', () => {
  test('guarda o caminho inteiro e também sem o primeiro diretório', () => {
    const t = arquivosTocados({ evidencia: { arquivosCommitados: ['backend/src/routes/auth.ts'] } })
    assert.ok(t.has('backend/src/routes/auth.ts'))
    // O critério cita relativo ao repo do componente: "src/routes/auth.ts".
    assert.ok(t.has('src/routes/auth.ts'))
  })

  test('normaliza barra invertida do Windows', () => {
    const t = arquivosTocados({ evidencia: { arquivosCommitados: ['backend\\src\\routes\\auth.ts'] } })
    assert.ok(t.has('backend/src/routes/auth.ts'))
  })
})

describe('avaliarCriterios — arquivo nomeado e não tocado é sinal forte', () => {
  const revisaoMecanica = {
    evidencia: {
      arquivosCommitados: [
        'backend/prisma/schema.prisma',
        'shared/types/api.ts',
        'backend/prisma/migrations/20261018000000_add_cor_usuario/migration.sql',
      ],
    },
  }

  test('acusa o critério que aponta arquivo que a task não tocou', () => {
    const task = {
      criterios: [
        'publicar o campo nos 4 pontos: CAMPOS_PUBLICAVEIS em src/routes/auth.ts:72-91 e selectUsuario em src/routes/usuarios.ts:27-39',
      ],
    }
    const r = avaliarCriterios({ task, revisaoMecanica, textoAgente: '' })
    assert.deepEqual(r.arquivosNaoTocados[0], ['src/routes/auth.ts', 'src/routes/usuarios.ts'])
    assert.match(r.nota, /ATENÇÃO/)
  })

  // Sem isto, o sinal acusaria de falso positivo justamente o arquivo que a
  // task acabou de criar, porque o critério cita a cauda do caminho.
  test('não acusa arquivo que a task criou, mesmo com o caminho pela cauda', () => {
    const task = {
      criterios: [
        'migration nova em backend/prisma/migrations/<timestamp>_add_cor_usuario/migration.sql, no padrao das migrations existentes',
      ],
    }
    const r = avaliarCriterios({ task, revisaoMecanica, textoAgente: '' })
    assert.deepEqual(r.arquivosNaoTocados, [], 'migration.sql foi tocada e não pode virar alerta')
    assert.doesNotMatch(r.nota, /ATENÇÃO/)
  })

  test('critério que não nomeia arquivo não gera esse sinal', () => {
    const task = { criterios: ['a coluna nasce nula para todo mundo'] }
    const r = avaliarCriterios({ task, revisaoMecanica, textoAgente: '' })
    assert.deepEqual(r.arquivosNaoTocados, [])
  })

  test('o alerta explica que gate verde não cobre isso', () => {
    const task = { criterios: ['teste em src/routes/usuarios.test.ts copiando o padrão'] }
    const r = avaliarCriterios({ task, revisaoMecanica, textoAgente: '' })
    assert.match(r.nota, /testes antigos continuam passando/)
  })
})
