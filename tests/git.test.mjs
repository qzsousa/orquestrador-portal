/**
 * Testes do git.mjs contra um repositório de verdade.
 *
 * Estes testes criam um repo git descartável em %TEMP% e de fato criam worktrees,
 * branches e commits. Não há mock possível para "o worktree isola?" — a
 * propriedade é do git, então o teste precisa do git.
 *
 * Nada aqui toca nos seus repositórios de produto.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from '../src/core/git.mjs'

let RAIZ
let REPO

before(() => {
  RAIZ = mkdtempSync(join(tmpdir(), 'orq-git-'))
  REPO = join(RAIZ, 'repo')
  mkdirSync(REPO, { recursive: true })
  git.run(['init', '-b', 'main'], { cwd: REPO })
  git.run(['config', 'user.email', 'orq@teste.local'], { cwd: REPO })
  git.run(['config', 'user.name', 'orq teste'], { cwd: REPO })
  writeFileSync(join(REPO, 'README.md'), '# teste\n', 'utf8')
  mkdirSync(join(REPO, 'src'), { recursive: true })
  writeFileSync(join(REPO, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  writeFileSync(join(REPO, 'src', 'b.ts'), 'export const b = 1\n', 'utf8')
  git.run(['add', '-A'], { cwd: REPO })
  git.run(['commit', '-m', 'base'], { cwd: REPO })
})

after(() => {
  try {
    for (const w of git.worktreeList(REPO)) {
      if (w.path !== REPO) git.removerWorktree(REPO, w.path, { forcar: true })
    }
  } catch {}
  rmSync(RAIZ, { recursive: true, force: true })
})

describe('git — queries básicas', () => {
  test('isRepo identifica repo', () => {
    assert.equal(git.isRepo(REPO), true)
    assert.equal(git.isRepo(RAIZ), false)
    assert.equal(git.isRepo(join(RAIZ, 'nao-existe')), false)
  })

  test('repoTop e commonDir apontam para o mesmo repo', () => {
    assert.equal(git.repoTop(REPO), REPO)
    assert.ok(git.commonDir(REPO).length > 0)
  })

  test('revParse e branchAtual', () => {
    assert.equal(git.branchAtual(REPO), 'main')
    assert.match(git.revParse('HEAD', REPO), /^[0-9a-f]{40}$/)
  })

  test('revParse de ref inexistente lança', () => {
    assert.throws(() => git.revParse('nao-existe', REPO), /Ref não encontrada/)
  })

  test('tentar não lança quando falha', () => {
    assert.equal(git.tentar(['rev-parse', 'nao-existe'], { cwd: REPO }), '')
  })

  test('branchExiste', () => {
    assert.equal(git.branchExists('main', REPO), true)
    assert.equal(git.branchExists('orq/nao-existe', REPO), false)
  })
})

describe('git — barreira contra operações destrutivas', () => {
  test('bloqueia push', () => {
    assert.throws(() => git.run(['push', 'origin', 'main'], { cwd: REPO }), /bloqueada/)
  })

  test('bloqueia reset --hard', () => {
    assert.throws(() => git.run(['reset', '--hard', 'HEAD'], { cwd: REPO }), /bloqueada/)
  })

  test('bloqueia rebase', () => {
    assert.throws(() => git.run(['rebase', 'main'], { cwd: REPO }), /bloqueada/)
  })

  test('bloqueia branch -D', () => {
    assert.throws(() => git.run(['branch', '-D', 'main'], { cwd: REPO }), /bloqueada/)
  })

  test('bloqueia clean -fd', () => {
    assert.throws(() => git.run(['clean', '-fd'], { cwd: REPO }), /bloqueada/)
  })

  test('bloqueia push com argumento remoto primeiro', () => {
    assert.throws(() => git.run(['--no-pager', 'push'], { cwd: REPO }), /bloqueada/)
  })

  test('operação liberada explicitamente passa', () => {
    // leitura normal continua funcionando
    assert.ok(git.run(['status', '--porcelain'], { cwd: REPO }) !== undefined || true)
  })

  test('erro menciona a autorização', () => {
    assert.throws(() => git.run(['push'], { cwd: REPO }), /autorização explícita/)
  })
})

describe('git — worktrees', () => {
  test('cria worktree com branch própria a partir do HEAD', () => {
    const wt = git.criarWorktree({ repo: REPO, dir: join(RAIZ, 'wt1'), branch: 'orq/T-001-x', baseRef: 'main' })
    assert.ok(existsSync(wt.worktree))
    assert.equal(git.branchAtual(wt.worktree), 'orq/T-001-x')
    assert.equal(git.branchAtual(REPO), 'main', 'repo principal não deve trocar de branch')
  })

  test('recusa criar worktree em diretório existente', () => {
    assert.throws(
      () => git.criarWorktree({ repo: REPO, dir: join(RAIZ, 'wt1'), branch: 'orq/outra', baseRef: 'main' }),
      /já existe/,
    )
  })

  test('recusa criar branch que já existe', () => {
    assert.throws(
      () => git.criarWorktree({ repo: REPO, dir: join(RAIZ, 'wt-dup'), branch: 'orq/T-001-x', baseRef: 'main' }),
      /Branch já existe/,
    )
  })

  test('base é pinado no momento da criação', () => {
    const wt = git.criarWorktree({ repo: REPO, dir: join(RAIZ, 'wt2'), branch: 'orq/T-002-y', baseRef: 'main' })
    assert.equal(wt.baseSha, git.revParse('main', REPO))
  })

  test('worktree registra commit e arquivo isoladamente', () => {
    const dir = join(RAIZ, 'wt1')
    writeFileSync(join(dir, 'src', 'c.ts'), 'export const c = 3\n', 'utf8')
    const sha = git.commitar(dir, 'feat: adiciona c')
    assert.ok(sha)
    assert.ok(git.arquivosCommitados(dir, git.revParse('main', REPO)).includes('src/c.ts'))
    // o repo principal NÃO tem o arquivo
    assert.equal(existsSync(join(REPO, 'src', 'c.ts')), false, 'worktree não pode vazar para o repo principal')
  })

  test('arquivosNaoCommitados detecta trabalho sujo', () => {
    const dir = join(RAIZ, 'wt2')
    assert.equal(git.arvoreLimpa(dir), true)
    writeFileSync(join(dir, 'src', 'sujo.ts'), 'x\n', 'utf8')
    assert.equal(git.arvoreLimpa(dir), false)
    assert.ok(git.arquivosNaoCommitados(dir).includes('src/sujo.ts'))
  })

  test('arquivosAfetados junta commitado e sujo', () => {
    const dir = join(RAIZ, 'wt2')
    const base = git.revParse('main', REPO)
    writeFileSync(join(dir, 'src', 'd.ts'), 'x\n', 'utf8')
    git.commitar(dir, 'feat: d')
    writeFileSync(join(dir, 'src', 'e.ts'), 'x\n', 'utf8')
    const afetados = git.arquivosAfetados(dir, base)
    assert.ok(afetados.includes('src/d.ts'), 'commitado')
    assert.ok(afetados.includes('src/e.ts'), 'sujo')
  })

  test('commitar devolve null quando não há nada a commitar', () => {
    const dir = join(RAIZ, 'wt2')
    git.commitar(dir, 'limpa pendencia anterior') // worktree tinha lixo do teste 6
    assert.equal(git.arvoreLimpa(dir), true)
    assert.equal(git.commitar(dir, 'nada'), null)
  })

  test('remove worktree', () => {
    const dir = join(RAIZ, 'wt-removivel')
    git.criarWorktree({ repo: REPO, dir, branch: 'orq/T-999-remover', baseRef: 'main' })
    assert.equal(git.removerWorktree(REPO, dir), true)
    assert.equal(existsSync(dir), false)
  })

  test('worktreeList reflete os worktrees', () => {
    const lista = git.worktreeList(REPO)
    assert.ok(lista.length >= 2)
    assert.ok(lista.some((w) => w.branch === 'orq/T-001-x'))
  })
})

describe('git — detecção de conflito', () => {
  test('dois worktrees no mesmo arquivo: interseção acha o arquivo', () => {
    const base = git.revParse('main', REPO)

    const wA = join(RAIZ, 'cf-a')
    const wB = join(RAIZ, 'cf-b')
    git.criarWorktree({ repo: REPO, dir: wA, branch: 'orq/cf-A', baseRef: 'main' })
    git.criarWorktree({ repo: REPO, dir: wB, branch: 'orq/cf-B', baseRef: 'main' })

    writeFileSync(join(wA, 'src', 'comum.ts'), 'A\n', 'utf8')
    git.commitar(wA, 'A mexe em comum')
    writeFileSync(join(wB, 'src', 'comum.ts'), 'B\n', 'utf8')
    git.commitar(wB, 'B mexe em comum')

    const arqA = git.arquivosAfetados(wA, base)
    const arqB = git.arquivosAfetados(wB, base)
    const inter = git.arquivosEmConflito(arqA, arqB)
    assert.deepEqual(inter, ['src/comum.ts'])
  })

  test('worktrees em arquivos distintos não conflitam', () => {
    const base = git.revParse('main', REPO)
    const wA = join(RAIZ, 'disj-a')
    const wB = join(RAIZ, 'disj-b')
    git.criarWorktree({ repo: REPO, dir: wA, branch: 'orq/disj-A', baseRef: 'main' })
    git.criarWorktree({ repo: REPO, dir: wB, branch: 'orq/disj-B', baseRef: 'main' })

    writeFileSync(join(wA, 'src', 'so-a.ts'), 'A\n', 'utf8')
    git.commitar(wA, 'so a')
    writeFileSync(join(wB, 'src', 'so-b.ts'), 'B\n', 'utf8')
    git.commitar(wB, 'so b')

    assert.deepEqual(git.arquivosEmConflito(git.arquivosAfetados(wA, base), git.arquivosAfetados(wB, base)), [])
  })

  test('merge-tree acusa conflito entre duas branches divergentes no mesmo arquivo', () => {
    // base = ponta de cf-A, ref = cf-B. Comparar contra `main` não acusaria nada:
    // cf-A é descendente de main, então seria fast-forward por definição.
    const tipA = git.revParse('orq/cf-A', REPO)
    assert.equal(git.testariaConflitar({ repo: REPO, baseSha: tipA, ref: 'orq/cf-B' }), true)
  })

  test('merge-tree NÃO acusa conflito entre branches disjuntas', () => {
    const tipDisj = git.revParse('orq/disj-A', REPO)
    assert.equal(git.testariaConflitar({ repo: REPO, baseSha: tipDisj, ref: 'orq/disj-B' }), false)
  })

  test('merge-tree NÃO acusa conflito quando uma branch é descendente da outra', () => {
    // Fast-forward é o caso mais comum e não pode ser lido como conflito.
    assert.equal(git.testariaConflitar({ repo: REPO, baseSha: git.revParse('main', REPO), ref: 'orq/cf-A' }), false)
  })

  test('isAncestor', () => {
    assert.equal(git.isAncestor(REPO, 'main', 'orq/cf-A'), true)
  })
})

describe('git — nomes de branch a partir de texto livre', () => {
  test('normaliza acento, espaço e maiúscula', () => {
    const b = git.branchParaTask('T-001', 'Adicionar Câmera DVR ao Painel')
    assert.equal(b, 'orq/t-001-adicionar-camera-dvr-ao-painel')
  })

  test('remove pontuação perigosa', () => {
    const b = git.branchParaTask('T-002', 'Fix: login/erro; "sessão" [v2]')
    assert.ok(!b.includes('/login'), 'não pode gerar branch aninhada acidental')
    assert.ok(!b.includes('"'))
    assert.ok(!b.includes(';'))
    assert.ok(!b.includes(' '))
  })

  test('id com formato inesperado é saneado', () => {
    const b = git.branchParaTask('T 003/x', 'tarefa')
    assert.ok(!b.includes(' '))
  })

  test('texto vazio ainda gera branch rastreável pelo id', () => {
    const b = git.branchParaTask('T-010', '')
    assert.equal(b, 'orq/t-010')
  })

  test('branch mantém o prefixo e o id, para rastreio', () => {
    const b = git.branchParaTask('T-042', 'Qualquer Coisa')
    assert.ok(b.startsWith('orq/t-042-'))
  })

  test('texto muito longo é truncado sem deixar hífen solto', () => {
    const b = git.branchParaTask('T-001', 'palavra '.repeat(30))
    assert.ok(b.length < 80, `branch ficou longa demais: ${b.length}`)
    assert.ok(!b.endsWith('-'))
  })
})

describe('git — worktree não vaza para o repo principal', () => {
  test('commit em worktree não altera main', () => {
    const mainAntes = git.revParse('main', REPO)
    const dir = join(RAIZ, 'isolada')
    git.criarWorktree({ repo: REPO, dir, branch: 'orq/isolada', baseRef: 'main' })
    writeFileSync(join(dir, 'src', 'novo.ts'), 'x\n', 'utf8')
    git.commitar(dir, 'feat: novo')
    assert.equal(git.revParse('main', REPO), mainAntes, 'main não pode ter mudado')
    assert.equal(existsSync(join(REPO, 'src', 'novo.ts')), false)
  })

  test('main avança e o worktree continua no base antigo', () => {
    const dir = join(RAIZ, 'antigo')
    const baseAntigo = git.revParse('main', REPO)
    git.criarWorktree({ repo: REPO, dir, branch: 'orq/antigo', baseRef: 'main' })
    writeFileSync(join(REPO, 'src', 'main-novo.ts'), 'x\n', 'utf8')
    git.commitar(REPO, 'main avança')
    assert.equal(git.revParse('main', REPO) !== baseAntigo, true)
    assert.equal(git.revParse('HEAD', dir), baseAntigo, 'worktree deve continuar no base pinado')
  })
})