/**
 * Testes do taskstore: persistência e máquina de estados.
 *
 * O que importa testar aqui não é "o método retorna X", é: o estado sobrevive
 * a um restart, e uma task não consegue pular etapas. São as duas propriedades
 * que sustentam a confiança no orquestrador.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore, transicaoValida, ESTADOS, normalizarTarefa } from '../src/core/taskstore.mjs'

function dirTemporario() {
  return mkdtempSync(join(tmpdir(), 'orq-tstore-'))
}

describe('taskstore — criação e normalização', () => {
  test('gera id sequencial legível', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    assert.equal(s.criar('primeira').id, 'T-001')
    assert.equal(s.criar('segunda').id, 'T-002')
    rmSync(d, { recursive: true, force: true })
  })

  test('aceita string solta e preenche titulo e descricao', () => {
    const t = normalizarTarefa('fazer o botão de salvar')
    assert.equal(t.titulo, 'fazer o botão de salvar')
    assert.equal(t.descricao, 'fazer o botão de salvar')
    assert.equal(t.estado, 'pendente')
  })

  test('normaliza listas vindas de texto separado por virgula ou newline', () => {
    const t = normalizarTarefa({
      titulo: 'x',
      criterios: 'um critério; outro critério\nterceiro',
      dependsOn: 'T-001, T-002',
    })
    assert.deepEqual(t.criterios, ['um critério', 'outro critério', 'terceiro'])
    assert.deepEqual(t.dependsOn, ['T-001', 'T-002'])
  })

  test('ignora estado inválido e cai para pendente', () => {
    const t = normalizarTarefa({ titulo: 'x', estado: 'inventado' })
    assert.equal(t.estado, 'pendente')
  })

  test('limita prioridade ao intervalo 1..5', () => {
    assert.equal(normalizarTarefa({ titulo: 'x', prioridade: 99 }).prioridade, 5)
    assert.equal(normalizarTarefa({ titulo: 'x', prioridade: -3 }).prioridade, 1)
  })
})

describe('taskstore — máquina de estados', () => {
  test('rejeita pular de pendente direto para concluída', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('x')
    assert.throws(() => s.mudarEstado(t.id, 'concluida'), /Transição inválida/)
    assert.equal(s.obter(t.id).estado, 'pendente')
    rmSync(d, { recursive: true, force: true })
  })

  test('rejeita em-andamento -> aguardando-integracao pulando a revisão', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('x')
    s.mudarEstado(t.id, 'pronta')
    s.mudarEstado(t.id, 'em-andamento')
    assert.throws(() => s.mudarEstado(t.id, 'aguardando-integracao'), /Transição inválida/)
    rmSync(d, { recursive: true, force: true })
  })

  test('caminho feliz completo é aceito', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('x')
    s.mudarEstado(t.id, 'pronta')
    s.mudarEstado(t.id, 'em-andamento')
    s.mudarEstado(t.id, 'aguardando-revisao')
    s.mudarEstado(t.id, 'aguardando-integracao')
    s.mudarEstado(t.id, 'concluida')
    assert.equal(s.obter(t.id).estado, 'concluida')
    rmSync(d, { recursive: true, force: true })
  })

  test('entrar em em-andamento incrementa tentativa', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('x')
    s.mudarEstado(t.id, 'pronta')
    s.mudarEstado(t.id, 'em-andamento')
    s.mudarEstado(t.id, 'bloqueada')
    s.mudarEstado(t.id, 'pronta')
    s.mudarEstado(t.id, 'em-andamento')
    assert.equal(s.obter(t.id).tentativa, 2)
    rmSync(d, { recursive: true, force: true })
  })

  test('todos os estados têm transição válida para si mesmo', () => {
    for (const e of ESTADOS) assert.equal(transicaoValida(e, e), true, `${e} -> ${e}`)
  })

  test('concluida é terminal: não sai sem passar por revisão de novo', () => {
    assert.equal(transicaoValida('concluida', 'em-andamento'), false)
  })
})

describe('taskstore — persistência e recuperação', () => {
  test('estado sobrevive a recriação do objeto (simula restart)', () => {
    const d = dirTemporario()
    const s1 = new TaskStore(d)
    const t = s1.criar('tarefa importante')
    s1.mudarEstado(t.id, 'pronta')
    s1.atualizar(t.id, { branch: 'orq/T-001-x' }, 'branch')

    const s2 = new TaskStore(d) // "restart" do orquestrador
    const recuperado = s2.obter('T-001')
    assert.ok(recuperado, 'task deve existir após restart')
    assert.equal(recuperado.estado, 'pronta')
    assert.equal(recuperado.branch, 'orq/T-001-x')
    rmSync(d, { recursive: true, force: true })
  })

  test('escreve atomicamente e não deixa arquivo .tmp', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    s.criar('x')
    assert.ok(existsSync(join(d, 'tasks.json')))
    assert.ok(!existsSync(join(d, 'tasks.json.tmp')))
    rmSync(d, { recursive: true, force: true })
  })

  test('histórico append-only registra cada mudança', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('x')
    s.mudarEstado(t.id, 'pronta')
    s.mudarEstado(t.id, 'em-andamento')
    const ev = s.eventos()
    assert.ok(ev.length >= 3, `esperava >=3 eventos, veio ${ev.length}`)
    assert.equal(ev[0].tipo, 'criada')
    const transicoes = ev.filter((e) => e.tipo === 'estado')
    assert.equal(transicoes.length, 2)
    assert.equal(transicoes[0].de, 'pendente')
    assert.equal(transicoes[0].para, 'pronta')
    rmSync(d, { recursive: true, force: true })
  })

  test('tasks.json corrompido é preservado como backup e erro explica o caminho', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    s.criar('x')
    writeFileSync(join(d, 'tasks.json'), '{ isso nao é json', 'utf8')

    assert.throws(() => new TaskStore(d), /ilegível/)

    // O corrompido não pode sumir: é o único lugar onde o trabalho anterior
    // ainda está para alguém recuperar na mão.
    const restantes = readdirSync(d)
    const backup = restantes.find((f) => f.includes('corrompido'))
    assert.ok(backup, `esperava um backup .corrompido, achei: ${restantes.join(', ')}`)
    assert.equal(readFileSync(join(d, backup), 'utf8'), '{ isso nao é json')
    assert.ok(!existsSync(join(d, 'tasks.json')), 'o arquivo corrompido deve ter sido renomeado')
    rmSync(d, { recursive: true, force: true })
  })

  test('snapshot não deixa o estado meio escrito após muitas escritas', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    for (let i = 0; i < 60; i++) s.criar(`task ${i}`)
    const s2 = new TaskStore(d)
    assert.equal(s2.listar().length, 60)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('taskstore — dependências', () => {
  test('detecta dependência para task inexistente', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar({ titulo: 'x', dependsOn: ['T-999'] })
    const probs = s.dependenciasQuebradas()
    assert.equal(probs.length, 1)
    assert.equal(probs[0].taskId, t.id)
    assert.equal(probs[0].motivo, 'inexistente')
    rmSync(d, { recursive: true, force: true })
  })

  test('não reporta problema quando dependência existe', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    s.criar('a')
    s.criar({ titulo: 'b', dependsOn: ['T-001'] })
    assert.equal(s.dependenciasQuebradas().length, 0)
    rmSync(d, { recursive: true, force: true })
  })

  test('remove task do estado', () => {
    const d = dirTemporario()
    const s = new TaskStore(d)
    const t = s.criar('x')
    assert.equal(s.remover(t.id), true)
    assert.equal(s.obter(t.id), null)
    rmSync(d, { recursive: true, force: true })
  })
})