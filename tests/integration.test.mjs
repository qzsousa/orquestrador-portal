/**
 * Testes da integração: idempotência e o que o relatório afirma.
 *
 * Fazem repositório, branches, worktrees e merges de verdade. "Integrar duas
 * vezes dá o mesmo resultado?" é uma propriedade do git, não da nossa lógica —
 * e é justamente a propriedade que faltava.
 *
 * Nada aqui toca nos repositórios de produto.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from '../src/core/git.mjs'
import { integrar, prepararIntegracao, aplicarNaPrincipal, limparIntegracao } from '../src/core/integration.mjs'

let RAIZ
let REPO
let CFG

/** Cria uma task: commit isolado numa branch própria, no arquivo indicado. */
function criarTask(id, arquivo, conteudo) {
  const branch = `orq/${id}`
  const wt = join(RAIZ, 'wt', id)
  git.criarWorktree({ repo: REPO, dir: wt, branch, baseRef: 'main' })
  writeFileSync(join(wt, arquivo), conteudo, 'utf8')
  git.run(['add', '-A'], { cwd: wt })
  git.run(['commit', '-m', `${id}: muda ${arquivo}`], { cwd: wt })
  const baseSha = git.revParse('main', REPO)
  git.removerWorktree(REPO, wt, { forcar: true })
  return {
    id,
    titulo: `task ${id}`,
    branch,
    baseSha,
    baseRef: 'main',
    componentes: [],
    arquivosAlvo: [arquivo],
    // `ordemDeIntegracao` só considera task neste estado; sem ele a integração
    // recebia uma lista vazia e reportava "0 tasks integradas" com sucesso.
    estado: 'aguardando-integracao',
  }
}

before(() => {
  RAIZ = mkdtempSync(join(tmpdir(), 'orq-int-'))
  REPO = join(RAIZ, 'repo')
  mkdirSync(REPO, { recursive: true })
  git.run(['init', '-b', 'main'], { cwd: REPO })
  git.run(['config', 'user.email', 'orq@teste.local'], { cwd: REPO })
  git.run(['config', 'user.name', 'orq teste'], { cwd: REPO })
  writeFileSync(join(REPO, 'a.txt'), 'a\n', 'utf8')
  writeFileSync(join(REPO, 'b.txt'), 'b\n', 'utf8')
  git.run(['add', '-A'], { cwd: REPO })
  git.run(['commit', '-m', 'base'], { cwd: REPO })

  CFG = {
    worktreesDir: join(RAIZ, 'worktrees'),
    integrationBranchPrefix: 'orq-integracao',
    componentes: {},
  }
})

after(() => {
  try {
    for (const w of git.worktreeList(REPO)) {
      if (w.path !== REPO) git.removerWorktree(REPO, w.path, { forcar: true })
    }
  } catch {}
  rmSync(RAIZ, { recursive: true, force: true })
})

beforeEach(() => {
  // Cada teste parte de um repositório limpo: a branch de integração precisa
  // poder não existir, que é o caso interesting da idempotência.
  try {
    git.run(['worktree', 'prune'], { cwd: REPO })
  } catch {}
})

describe('integrar — idempotência', () => {
  test('rodar duas vezes não duplica merge nem commita de novo', () => {
    const t1 = criarTask('T-1', 'a.txt', 'a2\n')
    const t2 = criarTask('T-2', 'b.txt', 'b2\n')

    const primeira = integrar({ cfg: CFG, tasks: [t1, t2], repo: REPO, nome: 'idem' })
    assert.equal(primeira.aprovado, true, `primeira integração falhou: ${primeira.bloqueios.join('; ')}`)
    const commitsPrimeira = primeira.commits.length
    assert.ok(commitsPrimeira > 0)

    const segunda = integrar({ cfg: CFG, tasks: [t1, t2], repo: REPO, nome: 'idem' })

    // O resultado útil é o mesmo: nada integrou duas vezes.
    assert.deepEqual(
      segunda.resultados.map((r) => ({ id: r.taskId, ok: r.ok, jaIntegrada: r.jaIntegrada })),
      [
        { id: 'T-1', ok: true, jaIntegrada: true },
        { id: 'T-2', ok: true, jaIntegrada: true },
      ],
    )
    assert.deepEqual(segunda.bloqueios, [])
    assert.equal(segunda.commits.length, commitsPrimeira, 'a segunda rodada inventou commits')
  })

  test('task nova entra na branch que já existe, sem perder o que já estava lá', () => {
    const t1 = criarTask('T-3', 'a.txt', 'a3\n')
    integrar({ cfg: CFG, tasks: [t1], repo: REPO, nome: 'cresce' })

    const t2 = criarTask('T-4', 'b.txt', 'b4\n')
    const rel = integrar({ cfg: CFG, tasks: [t1, t2], repo: REPO, nome: 'cresce' })

    assert.equal(rel.aprovado, true, rel.bloqueios.join('; '))
    assert.deepEqual(
      rel.resultados.map((r) => r.jaIntegrada),
      [true, false],
      'T-3 já estava e T-4 é nova'
    )
    // O conteúdo dos dois está na branch de integração.
    const conteudo = git.run(['show', 'HEAD:a.txt'], { cwd: rel.integracao.worktree })
    assert.equal(conteudo.trim(), 'a3')
    assert.equal(git.run(['show', 'HEAD:b.txt'], { cwd: rel.integracao.worktree }).trim(), 'b4')
  })

  test('merge que não muda nada não gera commit vazio', () => {
    const t1 = criarTask('T-5', 'a.txt', 'a5\n')
    const primeira = integrar({ cfg: CFG, tasks: [t1], repo: REPO, nome: 'vazio' })
    const antes = primeira.commits.length

    const segunda = integrar({ cfg: CFG, tasks: [t1], repo: REPO, nome: 'vazio' })

    assert.equal(segunda.commits.length, antes)
    assert.equal(
      segunda.commits.filter((c) => c.mensagem.startsWith('merge(T-5)') && c.mensagem === 'merge(T-5)').length <= 1,
      true,
    )
  })
})

describe('aplicarNaPrincipal', () => {
  test('usa a BRANCH, e não o baseSha — que seria um no-op silencioso', () => {
    const t1 = criarTask('T-6', 'a.txt', 'a6\n')
    const rel = integrar({ cfg: CFG, tasks: [t1], repo: REPO, nome: 'aplica' })

    const mainAntes = git.revParse('main', REPO)
    const aplicado = aplicarNaPrincipal({
      repo: REPO,
      branchIntegracao: rel.branchIntegracao,
      baseSha: rel.integracao.baseSha,
      branchPrincipal: 'main',
    })

    assert.notEqual(aplicado.depois, mainAntes, 'aplicar não mudou nada em main')
    assert.equal(git.revParse('main', REPO), aplicado.depois)
    assert.equal(git.run(['show', 'main:a.txt'], { cwd: REPO }).trim(), 'a6')
  })

  test('baseSha sozinho seria um no-op: por isso a branch é obrigatória', () => {
    const t1 = criarTask('T-7', 'a.txt', 'a7\n')
    const rel = integrar({ cfg: CFG, tasks: [t1], repo: REPO, nome: 'noop' })

    // `baseSha` é o ponto de divergência com a main. Trazer só ele seria um
    // merge que não aplica nada, e ainda assim maritaria tasks como feitas.
    assert.equal(git.revParse(rel.integracao.baseSha, REPO), git.revParse('main', REPO))
  })
})

describe('prepararIntegracao', () => {
  test('reaproveita a branch quando ela existe', () => {
    const t1 = criarTask('T-8', 'a.txt', 'a8\n')
    const primeira = prepararIntegracao({ cfg: CFG, repo: REPO, nome: 'reaproveita' })
    assert.equal(primeira.reaproveitada, false)
    git.removerWorktree(REPO, primeira.worktree, { forcar: true })

    const segunda = prepararIntegracao({ cfg: CFG, repo: REPO, nome: 'reaproveita' })
    assert.equal(segunda.reaproveitada, true)
    assert.equal(segunda.branch, primeira.branch)
    git.removerWorktree(REPO, segunda.worktree, { forcar: true })
    assert.equal(git.branchExists(primeira.branch, REPO), true)
  })

  test('devolve os problemas de ambiente em vez de engolir', () => {
    const p = prepararIntegracao({ cfg: CFG, repo: REPO, nome: 'ambiente' })
    assert.ok(Array.isArray(p.ambiente.problemas))
    git.removerWorktree(REPO, p.worktree, { forcar: true })
  })
})

describe('limparIntegracao', () => {
  test('devolve o que não conseguiu limpar, em vez de um booleano mudo', () => {
    const p = prepararIntegracao({ cfg: CFG, repo: REPO, nome: 'limpa' })
    const r = limparIntegracao({ repo: REPO, dir: p.worktree })

    assert.equal(r.removido, true)
    assert.ok(Array.isArray(r.falhas))

    // Idempotente: limpar o que não existe mais não é erro.
    const r2 = limparIntegracao({ repo: REPO, dir: p.worktree })
    assert.equal(r2.removido, false)
    assert.deepEqual(r2.falhas, [])
  })
})
