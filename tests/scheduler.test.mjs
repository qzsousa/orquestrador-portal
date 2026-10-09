/**
 * Testes do scheduler: quem pode rodar junto, e quem não pode.
 *
 * Este é o arquivo que protege a propriedade que o usuário mais pediu: dois
 * agentes nunca editando a mesma coisa ao mesmo tempo.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { selecionarDespachaveis, dependenciasSatisfeitas, motivoBloqueio, reconciliarEstados, ordemDeIntegracao } from '../src/core/scheduler.mjs'

const t = (id, extra = {}) => ({ id, dependsOn: [], estado: 'pronta', prioridade: 3, risco: 'medio', ...extra })

const porId = (tasks) => new Map(tasks.map((x) => [x.id, x]))

describe('scheduler — dependências', () => {
  test('task com dependência concluída está satisfeita', () => {
    const tasks = [t('A', { estado: 'concluida' }), t('B', { dependsOn: ['A'] })]
    assert.equal(dependenciasSatisfeitas(tasks[1], porId(tasks)), true)
  })

  test('task com dependência em andamento NÃO está satisfeita', () => {
    const tasks = [t('A', { estado: 'em-andamento' }), t('B', { dependsOn: ['A'] })]
    assert.equal(dependenciasSatisfeitas(tasks[1], porId(tasks)), false)
  })

  test('dependência inexistente nunca é satisfeita', () => {
    assert.equal(dependenciasSatisfeitas(t('B', { dependsOn: ['ZZZ'] }), porId([t('B')])), false)
  })

  test('task aguardando revisão bloqueia a dependente', () => {
    const tasks = [t('A', { estado: 'aguardando-revisao' }), t('B', { dependsOn: ['A'] })]
    assert.equal(dependenciasSatisfeitas(tasks[1], porId(tasks)), false)
  })

  test('task falhada bloqueia a dependente', () => {
    const tasks = [t('A', { estado: 'falhou' }), t('B', { dependsOn: ['A'] })]
    assert.equal(dependenciasSatisfeitas(tasks[1], porId(tasks)), false)
  })

  test('task sem dependência está satisfeita', () => {
    assert.equal(dependenciasSatisfeitas(t('A'), porId([t('A')])), true)
  })

  test('todas as dependências precisam estar satisfeitas', () => {
    const tasks = [
      t('A', { estado: 'concluida' }),
      t('B', { estado: 'em-andamento' }),
      t('C', { dependsOn: ['A', 'B'] }),
    ]
    assert.equal(dependenciasSatisfeitas(tasks[2], porId(tasks)), false)
  })

  test('motivoBloqueio nomeia quem falta', () => {
    const tasks = [t('A', { estado: 'em-andamento' }), t('B', { dependsOn: ['A'] })]
    const m = motivoBloqueio(tasks[1], tasks)
    assert.equal(m.tipo, 'dependencia')
    assert.match(m.mensagem, /A \(em-andamento\)/)
  })
})

describe('scheduler — seleção', () => {
  test('respeita o teto de concorrência', () => {
    const tasks = ['A', 'B', 'C', 'D', 'E'].map((id) => t(id))
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 2 })
    assert.equal(despachaveis.length, 2)
  })

  test('respeita teto de 1', () => {
    const tasks = ['A', 'B', 'C'].map((id) => t(id))
    assert.equal(selecionarDespachaveis({ tasks, concurrency: 1 }).despachaveis.length, 1)
  })

  test('prioridade maior vai primeiro', () => {
    const tasks = [t('A', { prioridade: 1 }), t('B', { prioridade: 5 })]
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 1 })
    assert.equal(despachaveis[0].id, 'B')
  })

  test('task bloqueada não é despachada', () => {
    const tasks = [t('A', { estado: 'bloqueada' })]
    assert.equal(selecionarDespachaveis({ tasks, concurrency: 5 }).despachaveis.length, 0)
  })

  test('task já em andamento não é redespachada', () => {
    const tasks = [t('A', { estado: 'em-andamento' })]
    assert.equal(selecionarDespachaveis({ tasks, concurrency: 5 }).despachaveis.length, 0)
  })

  test('conta quem já está rodando contra o teto', () => {
    const tasks = [t('A', { estado: 'em-andamento' }), t('B'), t('C')]
    const { despachaveis, rodando } = selecionarDespachaveis({ tasks, concurrency: 2 })
    assert.equal(rodando.length, 1)
    assert.equal(despachaveis.length, 1, 'com 1 rodando e teto 2, só cabe mais 1')
  })

  test('nunca ultrapassa o teto contando as rodando', () => {
    const tasks = [t('A', { estado: 'em-andamento' }), t('B', { estado: 'em-andamento' }), t('C'), t('D')]
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 2 })
    assert.equal(despachaveis.length, 0)
  })
})

describe('scheduler — exclusão por conflito de arquivo', () => {
  test('duas tasks no mesmo arquivo NÃO rodam juntas', () => {
    const tasks = [
      t('A', { arquivosAlvo: ['src/views/ChamadosView.vue'] }),
      t('B', { arquivosAlvo: ['src/views/ChamadosView.vue'] }),
    ]
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 5 })
    assert.equal(despachaveis.length, 1, 'só uma pode ir por vez')
    assert.equal(despachaveis[0].id, 'A')
  })

  test('task conflita com quem está RODANDO agora', () => {
    const tasks = [
      t('A', { estado: 'em-andamento', arquivosAlvo: ['src/views/X.vue'] }),
      t('B', { arquivosAlvo: ['src/views/X.vue'] }),
    ]
    const claimFiles = { A: ['src/views/X.vue'], B: ['src/views/X.vue'] }
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 5, claimFiles })
    assert.equal(despachaveis.length, 0, 'não pode despachar B enquanto A mexe no mesmo arquivo')
  })

  test('conflito por diretório também exclui', () => {
    const tasks = [
      t('A', { arquivosAlvo: ['src/views/'] }),
      t('B', { arquivosAlvo: ['src/views/ManutencaoView.vue'] }),
    ]
    assert.equal(selecionarDespachaveis({ tasks, concurrency: 5 }).despachaveis.length, 1)
  })

  test('arquivos disjuntos rodam em paralelo', () => {
    const tasks = [
      t('A', { arquivosAlvo: ['src/views/A.vue'] }),
      t('B', { arquivosAlvo: ['src/api/b.ts'] }),
    ]
    assert.equal(selecionarDespachaveis({ tasks, concurrency: 5 }).despachaveis.length, 2)
  })

  test('três tasks, duas em conflito: escolhe as duas livres', () => {
    const tasks = [
      t('A', { arquivosAlvo: ['src/shared/x.ts'], prioridade: 1 }),
      t('B', { arquivosAlvo: ['src/shared/x.ts'], prioridade: 1 }),
      t('C', { arquivosAlvo: ['src/views/c.vue'], prioridade: 1 }),
    ]
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 5 })
    assert.deepEqual(despachaveis.map((x) => x.id).sort(), ['A', 'C'])
  })

  test('conflito é resolvido por prioridade quando ambas disputam', () => {
    const tasks = [
      t('A', { arquivosAlvo: ['src/x.ts'], prioridade: 1 }),
      t('B', { arquivosAlvo: ['src/x.ts'], prioridade: 5 }),
    ]
    const { despachaveis } = selecionarDespachaveis({ tasks, concurrency: 1 })
    assert.equal(despachaveis[0].id, 'B')
  })
})

describe('scheduler — reconciliação de estados', () => {
  test('task sem dependência pendente vira pronta', () => {
    const store = fakeStore([t('A', { estado: 'pendente' })])
    const mud = reconciliarEstados(store)
    assert.equal(store.dados.tasks.A.estado, 'pronta')
    assert.equal(mud.length, 1)
  })

  test('task com dependência pendente vai para aguardando-dependencia', () => {
    const store = fakeStore([t('A', { estado: 'em-andamento' }), t('B', { estado: 'pendente', dependsOn: ['A'] })])
    reconciliarEstados(store)
    assert.equal(store.dados.tasks.B.estado, 'aguardando-dependencia')
  })

  test('dependência concluída libera a dependente', () => {
    const store = fakeStore([t('A', { estado: 'concluida' }), t('B', { estado: 'aguardando-dependencia', dependsOn: ['A'] })])
    reconciliarEstados(store)
    assert.equal(store.dados.tasks.B.estado, 'pronta')
  })

  test('reconciliação não mexe em task aguardando revisão', () => {
    const store = fakeStore([t('A', { estado: 'aguardando-revisao' })])
    reconciliarEstados(store)
    assert.equal(store.dados.tasks.A.estado, 'aguardando-revisao')
  })

  test('reconciliação é idempotente', () => {
    const store = fakeStore([t('A', { estado: 'pendente' }), t('B', { estado: 'pendente', dependsOn: ['A'] })])
    reconciliarEstados(store)
    const segunda = reconciliarEstados(store)
    assert.equal(segunda.length, 0)
  })

  test('reconciliação não mexe em concluída nem falhada', () => {
    const store = fakeStore([t('A', { estado: 'concluida' }), t('B', { estado: 'falhou' })])
    reconciliarEstados(store)
    assert.equal(store.dados.tasks.A.estado, 'concluida')
    assert.equal(store.dados.tasks.B.estado, 'falhou')
  })
})

describe('scheduler — ordem de integração', () => {
  test('ordena por dependência, não por prioridade', () => {
    const tasks = [
      t('A', { estado: 'aguardando-integracao', branch: 'b/A', prioridade: 1 }),
      t('B', { estado: 'aguardando-integracao', branch: 'b/B', prioridade: 5, dependsOn: ['A'] }),
    ]
    const ordem = ordemDeIntegracao(tasks).map((x) => x.id)
    assert.deepEqual(ordem, ['A', 'B'])
  })

  test('ignora task que não está aguardando integração', () => {
    const tasks = [t('A', { estado: 'pronta', branch: 'b/A' })]
    assert.equal(ordemDeIntegracao(tasks).length, 0)
  })
})

/** Store mínimo com a mesma interface que o TaskStore, para teste focado. */
function fakeStore(tasks) {
  return {
    dados: { tasks: Object.fromEntries(tasks.map((x) => [x.id, { ...x }])) },
    listar() {
      return Object.values(this.dados.tasks)
    },
    mudarEstado(id, para) {
      this.dados.tasks[id].estado = para
      return this.dados.tasks[id]
    },
  }
}