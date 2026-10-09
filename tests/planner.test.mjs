/**
 * Testes do planner: dependências, ordem, conflito e risco.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  subtarefasDeChecklist,
  deduzirDependencias,
  detectarCiclo,
  ordenarTopologicamente,
  preverConflitos,
  avaliarRisco,
  colidem,
} from '../src/core/planner.mjs'

const t = (id, extra = {}) => ({ id, titulo: id, dependsOn: [], ...extra })

describe('planner — decomposição por checklist', () => {
  test('checklist vira subtarefas encadeadas', () => {
    const task = t('T-001', { titulo: 'Cadastro de escola' })
    const subs = subtarefasDeChecklist(task, ['criar form', 'validar', 'testar'])
    assert.equal(subs.length, 3)
    assert.equal(subs[0].dependsOn.length, 0, 'primeira não depende de nada')
    assert.deepEqual(subs[1].dependsOn, ['T-001.1'])
    assert.deepEqual(subs[2].dependsOn, ['T-001.1', 'T-001.2'])
  })

  test('subtarefa guarda a origem da task-mãe', () => {
    const subs = subtarefasDeChecklist(t('T-001'), ['a', 'b'])
    assert.equal(subs[0].pai, 'T-001')
    assert.equal(subs[0].origem.subtarefaDe, 'T-001')
  })

  test('checklist vazio não gera subtarefa', () => {
    assert.equal(subtarefasDeChecklist(t('T-001'), []).length, 0)
  })

  test('ignora itens em branco', () => {
    const subs = subtarefasDeChecklist(t('T-001'), ['  ', 'real', ''])
    assert.equal(subs.length, 1)
    assert.equal(subs[0].titulo, 'real')
  })
})

describe('planner — dedução de dependências', () => {
  test('frontend que consome depende do backend que muda o contrato', () => {
    const tasks = [
      t('T-001', {
        titulo: 'Criar endpoint de avaliação de chamado no backend',
        descricao: 'nova rota de API para avaliação',
      }),
      t('T-002', {
        titulo: 'Exibir avaliação do chamado na tela do portal',
        descricao: 'chamar no frontend e mostrar na view',
      }),
    ]
    const { tasks: comDeps, raciocinios } = deduzirDependencias(tasks)
    const t2 = comDeps.find((x) => x.id === 'T-002')
    assert.ok(t2.dependsOn.includes('T-001'), `T-002 deveria depender de T-001; deps=${t2.dependsOn}`)
    assert.ok(raciocinios.some((r) => r.motivo.includes('contrato em comum')))
  })

  test('não deduz dependência entre tarefas sem assunto em comum', () => {
    const tasks = [
      t('T-001', { titulo: 'Nova rota de API de inventário', descricao: 'contrato novo' }),
      t('T-002', { titulo: 'Mostrar tutorial no frontend', descricao: 'exibir na tela' }),
    ]
    const { tasks: comDeps } = deduzirDependencias(tasks)
    assert.deepEqual(comDeps.find((x) => x.id === 'T-002').dependsOn, [])
  })

  test('não cria dependência circular entre consumidor e produtor', () => {
    const tasks = [
      t('T-001', { titulo: 'API de chamado', descricao: 'contrato' }),
      t('T-002', { titulo: 'tela de chamado', descricao: 'frontend chamado' }),
    ]
    const { tasks: comDeps } = deduzirDependencias(tasks)
    const t1 = comDeps.find((x) => x.id === 'T-001')
    const t2 = comDeps.find((x) => x.id === 'T-002')
    assert.ok(!(t1.dependsOn.includes('T-002') && t2.dependsOn.includes('T-001')), 'ciclo criado')
  })

  test('preserva dependência já declarada', () => {
    const tasks = [
      t('T-001', { titulo: 'x' }),
      t('T-002', { titulo: 'y', dependsOn: ['T-001'] }),
    ]
    const { tasks: comDeps } = deduzirDependencias(tasks)
    assert.deepEqual(comDeps.find((x) => x.id === 'T-002').dependsOn, ['T-001'])
  })
})

describe('planner — ciclos e ordenação', () => {
  test('detecta ciclo de dois nós', () => {
    const tasks = [t('A', { dependsOn: ['B'] }), t('B', { dependsOn: ['A'] })]
    const c = detectarCiclo(tasks)
    assert.ok(c, 'deveria detectar ciclo')
    assert.ok(c.includes('A') && c.includes('B'))
  })

  test('detecta ciclo de três nós', () => {
    const tasks = [t('A', { dependsOn: ['C'] }), t('B', { dependsOn: ['A'] }), t('C', { dependsOn: ['B'] })]
    assert.ok(detectarCiclo(tasks))
  })

  test('grafo sem ciclo não acusa nada', () => {
    const tasks = [t('A'), t('B', { dependsOn: ['A'] }), t('C', { dependsOn: ['A', 'B'] })]
    assert.equal(detectarCiclo(tasks), null)
  })

  test('ordenação topológica respeita dependência', () => {
    const tasks = [t('C', { dependsOn: ['B'] }), t('A'), t('B', { dependsOn: ['A'] })]
    const ordem = ordenarTopologicamente(tasks).map((x) => x.id)
    assert.ok(ordem.indexOf('A') < ordem.indexOf('B'))
    assert.ok(ordem.indexOf('B') < ordem.indexOf('C'))
  })

  test('ordenação topológica com ciclo falha em vez de devolver ordem parcial', () => {
    const tasks = [t('A', { dependsOn: ['B'] }), t('B', { dependsOn: ['A'] })]
    assert.throws(() => ordenarTopologicamente(tasks), /Ordenação impossível/)
  })

  test('ignora dependência apontando para task fora do conjunto', () => {
    const tasks = [t('A'), t('B', { dependsOn: ['ZZZ'] })]
    const ordem = ordenarTopologicamente(tasks).map((x) => x.id)
    assert.equal(ordem.length, 2)
  })
})

describe('planner — colisão de escopo', () => {
  test('arquivo igual colide', () => {
    assert.equal(colidem('src/views/A.vue', 'src/views/A.vue'), true)
  })

  test('arquivo dentro de diretório colide com o diretório', () => {
    assert.equal(colidem('src/views/', 'src/views/A.vue'), true)
    assert.equal(colidem('DIRETORIO:src/views/', 'src/views/A.vue'), true)
  })

  test('arquivos em diretórios diferentes não colidem', () => {
    assert.equal(colidem('src/views/A.vue', 'src/api/b.ts'), false)
  })
})

describe('planner — previsão de conflito', () => {
  test('duas tasks no mesmo arquivo sem dependência são conflito', () => {
    const tasks = [
      t('T-001', { arquivosAlvo: ['src/views/ChamadosView.vue'] }),
      t('T-002', { arquivosAlvo: ['src/views/ChamadosView.vue'] }),
    ]
    const conflitos = preverConflitos(tasks)
    assert.equal(conflitos.length, 1)
    assert.equal(conflitos[0].a, 'T-001')
    assert.equal(conflitos[0].b, 'T-002')
    assert.deepEqual(conflitos[0].arquivos, ['src/views/ChamadosView.vue'])
  })

  test('tasks com relação de dependência NÃO são conflito (ordem resolve)', () => {
    const tasks = [
      t('T-001', { arquivosAlvo: ['src/api/x.ts'] }),
      t('T-002', { arquivosAlvo: ['src/api/x.ts'], dependsOn: ['T-001'] }),
    ]
    assert.equal(preverConflitos(tasks).length, 0)
  })

  test('conflito em nível de diretório é detectado', () => {
    const tasks = [
      t('T-001', { arquivosAlvo: ['src/views/'] }),
      t('T-002', { arquivosAlvo: ['src/views/ManutencaoView.vue'] }),
    ]
    assert.equal(preverConflitos(tasks).length, 1)
  })

  test('severidade é alta para código, não para docs', () => {
    const tasks = [
      t('T-001', { arquivosAlvo: ['src/api/x.ts'] }),
      t('T-002', { arquivosAlvo: ['src/api/x.ts'] }),
    ]
    assert.equal(preverConflitos(tasks)[0].severidade, 'alta')

    const tasks2 = [
      t('T-001', { arquivosAlvo: ['docs/02-arquitetura.md'] }),
      t('T-002', { arquivosAlvo: ['docs/02-arquitetura.md'] }),
    ]
    assert.equal(preverConflitos(tasks2)[0].severidade, 'media')
  })

  test('tasks disjuntas não geram conflito', () => {
    const tasks = [
      t('T-001', { arquivosAlvo: ['src/views/A.vue'] }),
      t('T-002', { arquivosAlvo: ['src/views/B.vue'] }),
    ]
    assert.equal(preverConflitos(tasks).length, 0)
  })
})

describe('planner — avaliação de risco', () => {
  test('mudança de contrato e auth é alto', () => {
    assert.equal(avaliarRisco(t('T-001', { titulo: 'mudar contrato de autenticação e token' })), 'alto')
  })

  test('tarefa pequena e isolada é baixo', () => {
    assert.equal(avaliarRisco(t('T-001', { titulo: 'ajustar texto do botão' })), 'baixo')
  })

  test('tarefa que toca dois componentes é alto', () => {
    assert.equal(avaliarRisco(t('T-001', { titulo: 'ajustar detalhe' , componentes: ['portal', 'sce'] })), 'alto')
  })

  test('tarefa que apaga coisa é alto', () => {
    assert.equal(avaliarRisco(t('T-001', { titulo: 'remover tabela antiga do banco' })), 'alto')
  })
})