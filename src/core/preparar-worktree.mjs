/**
 * Ambiente de um worktree: fazer `npm test` rodar dentro dele.
 *
 * Existe porque o caminho óbvio — dar um junction de `node_modules` da raiz do
 * repo — não funciona num repositório com pacote próprio, e falhar calado é a
 * pior forma de falhar. Um worktree novo é uma cópia do git SEM `node_modules`
 * (é gitignored), então o gate sai com "cannot find module" e a task é reprovada
 * por um motivo que não tem nada a ver com o que ela fez.
 *
 * Três coisas, nesta ordem, porque cada uma corrige um jeito diferente do mesmo
 * problema:
 *
 * 1. **Junction por pacote, não só na raiz.** Num repositório como o `chamados`
 *    o `node_modules` que importa é o de `backend/`, não o da raiz — a raiz não
 *    tem nenhum. Um junction só na raiz não resolvia nada e o gate falhava
 *    igual. Aqui a busca é pelo repositório inteiro: todo diretório que tem
 *    `package.json` no repo base e `node_modules` ao lado ganha o seu.
 *
 * 2. **Dependência `file:` apontada para DENTRO do worktree.** É o defeito que
 *    não dá para ver. O `npm` transforma `"@shared/api": "file:../shared/types"`
 *    em um link para `<repoBase>/shared/types`. Aí o `tsc` do worktree lê o
 *    `dist/api.d.ts` da ÁRVORE BASE — o contrato que a task acabou de mudar não
 *    existe para o compilador. O gate passa com o contrato velho e reprova (ou,
 *    pior, aprova) por outro motivo. Relinkar para o worktree é o que faz a task
 *    ver a própria mudança.
 *
 * 3. **Build dos pacotes locais.** Mesmo relinkado, um pacote com
 *    `"main": "./dist/api.js"` entrega `dist` velho até alguém compilar. Sem este
 *    passo o gate lê o `.d.ts` de antes da task e aprova uma mudança de contrato
 *    que jamais foi vista.
 *
 * Nenhum passo aqui reprova a task por conta própria: o que falha fica em
 * `problemas` e é devolvido, para a revisão reportar a CAUSA em vez de
 * "module not found".
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Diretórios que nunca contêm um pacote nosso e são caros de varrer. */
const IGNORAR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'logs',
  '.state',
  'orq-worktrees',
  'worktrees',
  '.turbo',
  '.cache',
])

/** Profundidade máxima da busca. 4 níveis cobrem `a/b/c` sem varrer o universo. */
const PROFUNDIDADE_MAXIMA = 4

/**
 * Diretórios com `package.json`, mais os que realmente têm `node_modules`.
 *
 * A segunda lista é a que interessa para o junction: um pacote sem dependências
 * instaladas não precisa dele, e criar um apontando para lugar nenhum só
 * produziria um `node_modules` quebrado que engana o `npm` em vez de ajudar.
 */
export function pacotesDoRepo(repo) {
  const comManifesto = []
  const comDependencias = []

  const andar = (dir, profundidade) => {
    if (profundidade > PROFUNDIDADE_MAXIMA) return
    let entradas
    try {
      entradas = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entradas.some((e) => e.isFile() && e.name === 'package.json')) {
      comManifesto.push(dir)
      if (existsSync(join(dir, 'node_modules'))) comDependencias.push(dir)
    }
    for (const e of entradas) {
      if (!e.isDirectory()) continue
      if (IGNORAR.has(e.name)) continue
      if (e.name.startsWith('.')) continue
      andar(join(dir, e.name), profundidade + 1)
    }
  }

  andar(repo, 0)
  return { comManifesto, comDependencias }
}

function lerManifesto(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Remove um link sem apagar o destino.
 *
 * `rmSync(recursive)` num junction do Windows APAGA O CONTEÚDO ALVO em algumas
 * versões do Node. Apagar o `node_modules` do repo base por causa da limpeza de
 * um worktree é um prejuízo desproporcional ao que a limpeza devia resolver — e
 * acontecia em silêncio, porque o `catch` devolvia `false` e ninguém via.
 */
function removerLink(dir) {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return false // não existe: nada a fazer, e não é erro
  }
  if (st.isSymbolicLink()) {
    unlinkSync(dir)
    return true
  }
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Junction para o `node_modules` do repo base.
 *
 * Junction (e não symlink) porque no Windows symlink de diretório exige
 * privilégio de administrador; junction não.
 */
function criarJunction(destino, origem) {
  mkdirSync(dirname(destino), { recursive: true })
  symlinkSync(origem, destino, 'junction')
}

/** `existsSync` segue junction quebrado e responde "não", que é o caso perigoso. */
function existeLink(dir) {
  try {
    lstatSync(dir)
    return true
  } catch {
    return false
  }
}

function mesmoCaminho(a, b) {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()
  } catch {
    return false
  }
}

/**
 * Dependências `file:` declaradas por um pacote, com o caminho resolvido.
 *
 * O valor no `package.json` é relativo ao pacote que declara, não à raiz do
 * repositório — resolver errado aqui é o que faria o relink apontar para um
 * caminho que existe por acaso.
 */
export function depsLocais(pkgDir, manifesto) {
  const todas = { ...(manifesto?.dependencies || {}), ...(manifesto?.devDependencies || {}) }
  const out = []
  for (const [nome, spec] of Object.entries(todas)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    out.push({ nome, alvo: resolve(pkgDir, spec.slice('file:'.length)) })
  }
  return out
}

/**
 * Executa o `build` de um pacote local.
 *
 * Mesmo cuidado de shell do gate: os argumentos viram array e o npm é chamado
 * pelo próprio node, para que nenhum texto vindo do Trello possa virar comando.
 */
function construirPacote(pkgDir, timeoutMs = 5 * 60 * 1000) {
  const manifesto = lerManifesto(pkgDir)
  const script = manifesto?.scripts?.build
  if (!script) return { dir: pkgDir, pulado: true, ok: true, motivo: 'sem script de build' }

  const cli = npmCli()
  const comando = cli ? process.execPath : 'npm'
  const prefixo = cli ? [cli] : []
  const inicio = Date.now()
  const r = spawnSync(comando, [...prefixo, 'run', 'build'], {
    cwd: pkgDir,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    dir: pkgDir,
    pulado: false,
    ok: r.status === 0,
    exitCode: r.status,
    duracaoMs: Date.now() - inicio,
    erro: r.status === 0 ? null : (r.stderr || r.stdout || '').trim().split('\n').slice(-5).join(' | '),
  }
}

function npmCli() {
  if (process.platform !== 'win32') return null
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(cli) ? cli : null
}

/**
 * Instala o `node_modules` de um pacote no worktree.
 *
 * O caso fácil é um junction do diretório inteiro. Ele não serve quando o
 * pacote declara dependência `file:`, e o motivo é o que torna o defeito
 * silencioso: um junction do `node_modules` é o MESMO diretório do repo base, de
 * modo que "consertar" o link de `@shared/api` por dentro escreveria no base. A
 * task passaria a enxergar o contrato certo e, no worktree seguinte, todos —
 * inclusive a main — enxergariam o contrato da task anterior.
 *
 * Então, havendo dependência local, o `node_modules` do worktree vira um
 * diretório de verdade, e cada entrada é junctionada individualmente: todas
 * menos o que é `file:`, que aponta para o worktree. Custa uma entrada a mais
 * de I/O por pacote e é o que isola a task de verdade.
 */
function instalarNodeModules({ dirWt, dirBase, depsLocaisDoPacote }) {
  const destino = join(dirWt, 'node_modules')
  const origem = join(dirBase, 'node_modules')

  // Qual pacote dentro de qual escopo e local: `@shared/api` vira escopo
  // `@shared` com o pacote `api` dentro. Sem este desdobramento, o laco que
  // junctiona as entradas do escopo acabaria religando `api` para o BASE - que
  // e exatamente o defeito que a funcao existe para corrigir.
  const locaisPorEscopo = new Map()
  for (const dep of depsLocaisDoPacote) {
    const partes = dep.nome.split('/')
    const escopo = partes.length > 1 ? partes[0] : ''
    const pacote = partes.length > 1 ? partes.slice(1).join('/') : partes[0]
    if (!locaisPorEscopo.has(escopo)) locaisPorEscopo.set(escopo, new Map())
    locaisPorEscopo.get(escopo).set(pacote, dep)
  }

  if (locaisPorEscopo.size === 0) {
    if (existeLink(destino)) return { criado: false, motivo: 'ja existe', modo: 'junction' }
    try {
      criarJunction(destino, origem)
      return { criado: true, modo: 'junction' }
    } catch (err) {
      return { criado: false, motivo: `junction falhou: ${err.message}`, modo: 'junction' }
    }
  }

  if (existeLink(destino)) {
    // Junction antiga de uma rodada anterior, ou o `node_modules` real de um
    // pacote que agora passou a declarar `file:`. Qualquer um dos dois precisa
    // sair antes de virar um diretorio de verdade.
    try {
      removerLink(destino)
    } catch (err) {
      return { criado: false, motivo: `nao deu para remover o node_modules existente: ${err.message}`, modo: 'misturado' }
    }
  }
  mkdirSync(destino, { recursive: true })

  const problemas = []

  for (const e of listar(origem)) {
    if (locaisPorEscopo.has(e.name)) continue // escopo com pacote local: tratado abaixo
    try {
      criarJunction(join(destino, e.name), join(origem, e.name))
    } catch (err) {
      problemas.push(`nao deu para ligar ${e.name}: ${err.message}`)
    }
  }

  for (const [escopo, locais] of locaisPorEscopo) {
    const deEscopo = join(origem, escopo)
    const paraEscopo = join(destino, escopo)
    mkdirSync(paraEscopo, { recursive: true })

    for (const e of listar(deEscopo)) {
      if (locais.has(e.name)) continue // este e o local: entra com o destino do worktree
      try {
        criarJunction(join(paraEscopo, e.name), join(deEscopo, e.name))
      } catch (err) {
        problemas.push(`nao deu para ligar ${escopo}/${e.name}: ${err.message}`)
      }
    }

    for (const [pacote, dep] of locais) {
      const link = join(paraEscopo, pacote)
      try {
        if (existeLink(link)) removerLink(link)
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(dep.alvo, link, 'junction')
      } catch (err) {
        problemas.push(`nao deu para ligar ${escopo ? `${escopo}/` : ''}${pacote} para dentro do worktree: ${err.message}`)
      }
    }
  }

  return {
    criado: true,
    modo: 'misturado',
    locais: [...locaisPorEscopo.values()].flatMap((m) => [...m.values()].map((d) => d.nome)),
    problemas,
  }
}

function listar(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Prepara o worktree inteiro para rodar os gates.
 *
 * @param {object} opcoes
 * @param {string[]} [opcoes.subdirs] Subdiretórios com gate, relativos à raiz.
 *   Entra na lista mesmo quando o repo base não tem `node_modules` lá: é o
 *   `cwd` declarado do gate, e um gate cujo cwd não tem dependência falha com
 *   "tsc não é reconhecido", o que parece falha do código integrado.
 *
 * @returns {{pacotes:object[], relinks:object[], builds:object[], problemas:string[]}}
 */
export function prepararWorktree({ worktree, repoBase, log = () => {}, subdirs = [] }) {
  const pacotes = []
  const relinks = []
  const builds = []
  const problemas = []

  // --- 1. node_modules por pacote, com as dependências locais apontando para
  //        dentro do worktree -----------------------------------------------
  const alvos = new Set(pacotesDoRepo(repoBase).comDependencias)
  for (const sub of subdirs) {
    const dir = join(repoBase, sub)
    if (existsSync(join(dir, 'node_modules'))) alvos.add(dir)
  }

  for (const dirBase of alvos) {
    const rel = relative(repoBase, dirBase)
    const dirWt = rel ? join(worktree, rel) : worktree

    // O manifesto vem do WORKTREE: a task pode ter declarado `file:` novo, e é
    // o manifesto dela que vale.
    const deps = depsLocais(dirWt, lerManifesto(dirWt))

    const r = instalarNodeModules({ dirWt, dirBase, depsLocaisDoPacote: deps })
    if (r.criado) {
      log(`      node_modules: ${rel || '.'} (${r.modo}${r.modo === 'misturado' ? `, local: ${(r.locais || []).join(', ')}` : ''})`)
    }
    pacotes.push({ dir: rel || '.', ...r })
    problemas.push(...(r.problemas || []))

    for (const dep of deps) {
      if (!dentroDe(dep.alvo, repoBase)) continue // `file:` para fora: outro projeto
      const alvoWt = join(worktree, relative(repoBase, dep.alvo))
      if (!existeLink(alvoWt)) {
        problemas.push(`${dep.nome} aponta para ${alvoWt}, que não existe neste worktree.`)
        continue
      }
      relinks.push({ nome: dep.nome, pacote: dirWt, alvo: alvoWt, feito: true })
    }
  }


  // --- 3. build dos pacotes locais -----------------------------------------
  // Só dos que realmente foram relinkados: um pacote já ligado e já compilado
  // não precisa recompilar, e compilar tudo em todo worktree é exatamente o
  // custo que levava a pularem o gate.
  const vistos = new Set()
  for (const r of relinks) {
    if (!r.feito || vistos.has(r.nome)) continue
    const b = construirPacote(r.alvo)
    builds.push({ ...b, nome: r.nome })
    if (!b.ok) {
      problemas.push(`Build de ${r.nome} falhou (exit ${b.exitCode}): ${b.erro}`)
    }
    vistos.add(r.nome)
  }

  return { pacotes, relinks, builds, problemas }
}

function dentroDe(alvo, raiz) {
  const rel = relative(raiz, alvo)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && resolve(alvo) !== resolve(raiz)
}

/**
 * Remove um `node_modules` que é diretório de verdade cheio de junction.
 *
 * `rmSync(recursive)` direto sobre ele percorre as junctions e apaga o CONTEÚDO
 * do repo base — o mesmo prejuízo do caso simples, só que agora com um nível a
 * mais de indireção. Então os links saem um a um com `unlink`, e só o que sobra
 * (o diretório vazio) é removido recursivamente.
 */
function removerArvoreDeLinks(dir) {
  let entradas
  try {
    entradas = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entradas) {
    const caminho = join(dir, e.name)
    let st
    try {
      st = lstatSync(caminho)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      try {
        unlinkSync(caminho)
      } catch {}
      continue
    }
    if (st.isDirectory()) removerArvoreDeLinks(caminho)
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

/**
 * Desfaz o que `prepararWorktree` fez.
 *
 * Devolve o que conseguiu remover E o que não conseguiu, em vez de engolir: um
 * link que sobra depois da limpeza faz o próximo `run` achar o worktree ocupado
 * e recusar, e a causa disso fica a quatro arquivos de distância.
 */
export function limparWorktree({ worktree, repoBase, log = () => {} }) {
  const removidos = []
  const falhas = []

  for (const dirBase of pacotesDoRepo(repoBase).comDependencias) {
    const rel = relative(repoBase, dirBase)
    const alvo = join(rel ? join(worktree, rel) : worktree, 'node_modules')
    if (!existeLink(alvo)) continue

    let st
    try {
      st = lstatSync(alvo)
    } catch {
      continue
    }

    try {
      if (st.isSymbolicLink()) {
        removerLink(alvo)
      } else {
        // Modo mistudo: diretório nosso, cheio de link nosso. Só sai o que é
        // link; o `node_modules` de verdade do repo base fica intocado.
        removerArvoreDeLinks(alvo)
      }
      removidos.push(join(rel || '.', 'node_modules'))
    } catch (err) {
      falhas.push(`${join(rel || '.', 'node_modules')}: ${err.message}`)
    }
  }

  if (falhas.length) log(`      aviso: ${falhas.length} node_modules não removido(s): ${falhas.join('; ')}`)
  return { removidos, falhas }
}