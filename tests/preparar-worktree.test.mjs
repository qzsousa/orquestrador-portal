/**
 * Testes do preparo de worktree contra um repositório de verdade.
 *
 * Fazem worktrees de verdade e junctions de verdade, porque a propriedade que
 * importa — "o `tsc` dentro do worktree vê o contrato que a task alterou?" — é
 * uma propriedade de link de filesystem, e nenhum mock a reproduz. Era
 * exatamente por isso que o defeito passou despercebido: os gates rodavam, o
 * `tsc` rodava, e ele lia a árvore errada.
 *
 * Nada aqui toca nos repositórios de produto.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from '../src/core/git.mjs'
import { prepararWorktree, limparWorktree, pacotesDoRepo, depsLocais } from '../src/core/preparar-worktree.mjs'

let RAIZ
let REPO
let WT

/**
 * Repo com o defeito do caso real: pacote próprio (`shared/types`) consumido por
 * `file:` de um pacote filho (`backend`), com `node_modules` em `backend/` e
 * não na raiz.
 */
function montarRepoComPacoteLocal() {
  git.run(['init', '-b', 'main'], { cwd: REPO })
  git.run(['config', 'user.email', 'orq@teste.local'], { cwd: REPO })
  git.run(['config', 'user.name', 'orq teste'], { cwd: REPO })

  const shared = join(REPO, 'shared', 'types')
  mkdirSync(shared, { recursive: true })
  writeFileSync(
    join(shared, 'package.json'),
    JSON.stringify({ name: '@shared/api', version: '1.0.0', main: './dist/api.js' }, null, 2),
    'utf8',
  )
  writeFileSync(join(shared, 'api.ts'), 'export const CONTRATO = "v1"\n', 'utf8')
  mkdirSync(join(shared, 'node_modules'), { recursive: true })

  const backend = join(REPO, 'backend')
  mkdirSync(backend, { recursive: true })
  writeFileSync(
    join(backend, 'package.json'),
    JSON.stringify(
      { name: 'backend', version: '1.0.0', dependencies: { '@shared/api': 'file:../shared/types' } },
      null,
      2,
    ),
    'utf8',
  )
  // node_modules com mais de uma entrada, para o relink não poder ser
  // "junctionou o diretório inteiro e deu por isso".
  mkdirSync(join(backend, 'node_modules', 'zod'), { recursive: true })
  writeFileSync(join(backend, 'node_modules', 'zod', 'package.json'), '{"name":"zod"}', 'utf8')
  mkdirSync(join(backend, 'node_modules', '@shared'), { recursive: true })

  // A junção que o npm cria para `file:`: aponta para a ÁRVORE BASE.
  symlinkSync(join(REPO, 'shared', 'types'), join(backend, 'node_modules', '@shared', 'api'), 'junction')

  git.run(['add', '-A'], { cwd: REPO })
  git.run(['commit', '-m', 'base com pacote local'], { cwd: REPO })
}

before(() => {
  RAIZ = mkdtempSync(join(tmpdir(), 'orq-wt-'))
  REPO = join(RAIZ, 'repo')
  mkdirSync(REPO, { recursive: true })
  montarRepoComPacoteLocal()

  WT = join(RAIZ, 'worktree')
  git.criarWorktree({ repo: REPO, dir: WT, branch: 'orq/teste', baseRef: 'main' })
})

after(() => {
  try {
    for (const w of git.worktreeList(REPO)) {
      if (w.path !== REPO) git.removerWorktree(REPO, w.path, { forcar: true })
    }
  } catch {}
  rmSync(RAIZ, { recursive: true, force: true })
})

describe('pacotesDoRepo', () => {
  test('acha pacote aninhado, não só o da raiz', () => {
    const { comManifesto, comDependencias } = pacotesDoRepo(REPO)
    const rel = (dir) => dir.replace(REPO, '').replace(/\\/g, '/')

    assert.ok(
      comManifesto.some((d) => rel(d) === '/backend'),
      `esperava achar backend/, achou: ${comManifesto.map(rel).join(', ')}`,
    )
    assert.ok(
      comManifesto.some((d) => rel(d) === '/shared/types'),
      `esperava achar shared/types/, achou: ${comManifesto.map(rel).join(', ')}`,
    )
    // Só entra em comDependencias quem TEM node_modules — link para lugar nenhum
    // só produziria um node_modules quebrado que engana o npm.
    assert.ok(comDependencias.some((d) => rel(d) === '/backend'))
  })

  test('não desce em node_modules nem em diretório escondido', () => {
    const antes = pacotesDoRepo(REPO).comManifesto.length
    mkdirSync(join(REPO, 'node_modules', 'falso'), { recursive: true })
    writeFileSync(join(REPO, 'node_modules', 'falso', 'package.json'), '{}', 'utf8')
    try {
      assert.equal(pacotesDoRepo(REPO).comManifesto.length, antes)
    } finally {
      rmSync(join(REPO, 'node_modules'), { recursive: true, force: true })
    }
  })
})

describe('depsLocais', () => {
  test('lê dependência file: e resolve o caminho relativo ao pacote que declara', () => {
    const manifesto = JSON.parse(readFileSync(join(REPO, 'backend', 'package.json'), 'utf8'))
    const deps = depsLocais(join(REPO, 'backend'), manifesto)

    assert.equal(deps.length, 1)
    assert.equal(deps[0].nome, '@shared/api')
    assert.equal(realpathSync(deps[0].alvo).toLowerCase(), realpathSync(join(REPO, 'shared', 'types')).toLowerCase())
  })

  test('ignora dependência que não é file:', () => {
    const deps = depsLocais(join(REPO, 'backend'), { dependencies: { zod: '^3.22.0' } })
    assert.deepEqual(deps, [])
  })
})

describe('prepararWorktree', () => {
  test('o pacote aninhado ganha node_modules, e as dependências comuns vêm do base', () => {
    const r = prepararWorktree({ worktree: WT, repoBase: REPO })

    assert.ok(existsSync(join(WT, 'backend', 'node_modules')), 'backend/node_modules deveria existir no worktree')
    // No modo mistudo o `node_modules` do worktree é um diretório nosso — não pode
    // ser a junction do base, ou o relink escreveria no base.
    assert.equal(lstatSync(join(WT, 'backend', 'node_modules')).isSymbolicLink(), false)
    assert.ok(r.pacotes.some((p) => p.dir === 'backend' && p.modo === 'misturado'))
    assert.deepEqual(r.problemas, [])
  })

  test('pacote sem dependência local recebe junction simples do node_modules inteiro', () => {
    mkdirSync(join(REPO, 'frontend', 'node_modules'), { recursive: true })
    writeFileSync(join(REPO, 'frontend', 'package.json'), '{"name":"frontend"}', 'utf8')
    try {
      const r = prepararWorktree({ worktree: WT, repoBase: REPO })

      const alvo = join(WT, 'frontend', 'node_modules')
      assert.ok(existeLink(alvo))
      // Junction do diretório: é o caminho barato, e sem `file:` não há por que
      // abrir mão dele.
      assert.equal(
        realpathSync(alvo).toLowerCase(),
        realpathSync(join(REPO, 'frontend', 'node_modules')).toLowerCase(),
      )
      assert.ok(r.pacotes.some((p) => p.dir === 'frontend' && p.modo === 'junction'))
    } finally {
      rmSync(join(REPO, 'frontend'), { recursive: true, force: true })
    }
  })

  test('a dependência file: aponta para DENTRO do worktree', () => {
    prepararWorktree({ worktree: WT, repoBase: REPO })

    const link = join(WT, 'backend', 'node_modules', '@shared', 'api')
    assert.ok(existeLink(link), 'o link de @shared/api deveria existir no worktree')

    // Este é O ponto: sem isto, o `tsc` do worktree lê o contrato da árvore
    // base e aprova uma mudança de contrato que ele nunca viu.
    assert.equal(
      realpathSync(link).toLowerCase(),
      realpathSync(join(WT, 'shared', 'types')).toLowerCase(),
    )
  })

  test('o repo base NÃO é reescrito: o link da base continua apontando para a base', () => {
    prepararWorktree({ worktree: WT, repoBase: REPO })

    // O furo mais caro possível: se o relink tivesse sido feito "por dentro" da
    // junction, ele teria escrito no node_modules do repo base — e a partir daí
    // todo worktree, e a main, leriam o contrato da task.
    const linkBase = join(REPO, 'backend', 'node_modules', '@shared', 'api')
    assert.equal(
      realpathSync(linkBase).toLowerCase(),
      realpathSync(join(REPO, 'shared', 'types')).toLowerCase(),
      'o link do repo base foi apontado para o worktree'
    )
  })

  test('dependência comum do node_modules continua vindo do repo base', () => {
    prepararWorktree({ worktree: WT, repoBase: REPO })

    // Só o que é `file:` muda de destino. O resto tem de continuar resolvendo
    // para o base, senão o worktree precisaria de um `npm install` inteiro.
    assert.ok(existeLink(join(WT, 'backend', 'node_modules', 'zod')))
    assert.equal(
      realpathSync(join(WT, 'backend', 'node_modules', 'zod')).toLowerCase(),
      realpathSync(join(REPO, 'backend', 'node_modules', 'zod')).toLowerCase(),
    )
  })

  test('rodar duas vezes não quebra o link nem duplica entradas', () => {
    prepararWorktree({ worktree: WT, repoBase: REPO })
    const link = join(WT, 'backend', 'node_modules', '@shared', 'api')
    const antes = realpathSync(link).toLowerCase()

    const r = prepararWorktree({ worktree: WT, repoBase: REPO })

    assert.equal(existeLink(link), true)
    assert.equal(realpathSync(link).toLowerCase(), antes)
    assert.deepEqual(r.problemas, [])
  })

  test('não tenta relinkar dependência file: que aponta para fora do repositório', () => {
    writeFileSync(
      join(WT, 'package.json'),
      JSON.stringify({ name: 'raiz', dependencies: { fora: 'file:../outro-repo' } }, null, 2),
      'utf8',
    )
    try {
      const r = prepararWorktree({ worktree: WT, repoBase: REPO })
      // Nenhum problema reportado: fora do repo é outro projeto, não escopo nosso.
      assert.deepEqual(r.problemas, [])
      assert.deepEqual(
        r.relinks.filter((x) => x.nome === 'fora'),
        [],
      )
    } finally {
      rmSync(join(WT, 'package.json'), { force: true })
    }
  })
})

describe('limparWorktree', () => {
  test('remove o node_modules do worktree sem apagar o do repo base', () => {
    prepararWorktree({ worktree: WT, repoBase: REPO })
    assert.ok(existeLink(join(WT, 'backend', 'node_modules')))

    const r = limparWorktree({ worktree: WT, repoBase: REPO })

    assert.deepEqual(r.falhas, [])
    assert.ok(!existeLink(join(WT, 'backend', 'node_modules')))
    // O ponto que não podia falhar: apagar o node_modules do repo base quebraria
    // todo gate seguinte, e o erro apareceria a quatro comandos de distância.
    assert.ok(existeLink(join(REPO, 'backend', 'node_modules')))
    assert.ok(existsSync(join(REPO, 'backend', 'node_modules', 'zod', 'package.json')))
    assert.ok(existeLink(join(REPO, 'backend', 'node_modules', '@shared', 'api')))
  })

  test('remover duas vezes não falha: idempotente', () => {
    prepararWorktree({ worktree: WT, repoBase: REPO })
    limparWorktree({ worktree: WT, repoBase: REPO })
    const r = limparWorktree({ worktree: WT, repoBase: REPO })

    assert.deepEqual(r.falhas, [])
    assert.deepEqual(r.removidos, [])
  })

  test('devolve lista de falhas em vez de silêncio', () => {
    const r = limparWorktree({ worktree: join(RAIZ, 'nao-existe'), repoBase: REPO })
    assert.ok(Array.isArray(r.removidos))
    assert.ok(Array.isArray(r.falhas))
  })
})

/** `existsSync` segue junction quebrado e responde "não". */
function existeLink(dir) {
  try {
    lstatSync(dir)
    return true
  } catch {
    return false
  }
}
