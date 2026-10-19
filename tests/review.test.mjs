import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { avaliarCriterios, arquivosDoCriterio, arquivosTocados, falhaDeAmbiente } from '../src/core/review.mjs'

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
    const a = arquivosDoCriterio('mexa em shared/types/api.ts (api.ts:790) e em x.vue.')
    assert.ok(a.includes('shared/types/api.ts'))
    assert.ok(a.includes('x.vue'))
  })

  // Arquivo citado como PADRÃO não é arquivo a mudar. Sem isso, o sinal grita
  // "não tocou" sobre `escolas.ts` toda vez que um critério manda copiar a
  // estrutura de lá, e quem lê aprende a ignorar o sinal.
  test('critério que cita arquivo como referência não gera sinal', () => {
    assert.deepEqual(arquivosDoCriterio('copiando a estrutura de src/routes/escolas.ts:50-96 para o GET'), [])
    assert.deepEqual(arquivosDoCriterio('usando a logica que ja existe em src/routes/dashboard.ts:58-77'), [])
    assert.deepEqual(arquivosDoCriterio('reusando requireRole de src/middleware/auth.ts:97-111'), [])
    assert.deepEqual(arquivosDoCriterio('responder com isZodError de src/utils/zodError.ts:21-23'), [])
  })

  test('critério que manda mudar o arquivo continua gerando sinal', () => {
    const a = arquivosDoCriterio('publicar o campo nos 4 pontos: CAMPOS_PUBLICAVEIS em src/routes/auth.ts:72-91')
    assert.deepEqual(a, ['src/routes/auth.ts'])
  })

  test('duvida resolve para mudança: sem marcador de referência, o arquivo conta', () => {
    // "em X" aparece nos dois sentidos ("publicar em X" e "a logica em X"). Na
    // dúvida o sinal acusa, porque o custo de accuse falso é uma conferida.
    const a = arquivosDoCriterio('o select de attachUserRecord em src/middleware/auth.ts:71-82')
    assert.deepEqual(a, ['src/middleware/auth.ts'])
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

describe('falhaDeAmbiente — gate que falha por causa da máquina', () => {
  // `prisma generate` reescreve o query engine dentro de node_modules, e o
  // worktree compartilha esse diretório com o repo base. Com o backend de dev
  // no ar, o Windows trava o DLL. Aconteceu 4 vezes e cada vez REPROVOU a task.
  const epem = {
    nome: 'prisma:generate',
    fase: 'preparar',
    ok: false,
    stderr:
      "Error: EPERM: operation not permitted, rename 'C:\\chamados\\backend\\node_modules\\.prisma\\client\\query_engine-windows.dll.node.tmp1' -> 'query_engine-windows.dll.node'",
  }

  test('DLL do Prisma travado é ambiente, com o remédio nomeado', () => {
    const r = falhaDeAmbiente(epem)
    assert.equal(r.gate, 'prisma:generate')
    assert.match(r.remedy, /Pare o backend/)
    assert.match(r.remedy, /Nada a corrigir na task/)
  })

  test('falha de verdade da task NÃO é classificada como ambiente', () => {
    assert.equal(falhaDeAmbiente({ nome: 'typecheck', fase: 'validar', ok: false, stderr: 'agenda.ts:10:5 error TS2345' }), null)
    assert.equal(falhaDeAmbiente({ nome: 'prisma:generate', fase: 'preparar', ok: false, stderr: 'P1001 Cannot reach database server' }), null)
  })

  test('EPERM em gate que não é o Prisma continua sendo falha', () => {
    assert.equal(
      falhaDeAmbiente({ nome: 'build', fase: 'preparar', ok: false, stderr: "EPERM: operation not permitted, rename 'x' -> 'y'" }),
      null,
      'sem menção ao engine do Prisma não é o caso conhecido',
    )
  })

  test('gate que passou não gera diagnóstico', () => {
    assert.equal(falhaDeAmbiente({ nome: 'prisma:generate', fase: 'preparar', ok: true }), null)
  })

  test('EPERM fora da fase de preparação não escapa da reprovação', () => {
    assert.equal(falhaDeAmbiente({ ...epem, fase: 'validar' }), null)
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
    const task = { criterios: ['o teste tem que entrar em src/routes/usuarios.test.ts'] }
    const r = avaliarCriterios({ task, revisaoMecanica, textoAgente: '' })
    assert.match(r.nota, /testes antigos continuam passando/)
  })
})
