/**
 * Revisão: o portão entre "o agente respondeu" e "a task está pronta".
 *
 * Regra central: resposta de agente não é evidência. O que conta é o estado do
 * repositório. Por isso a revisão é MECÂNICA primeiro — commits, árvore limpa,
 * gates reais, escopo — e só depois (opcionalmente) a leitura dos critérios de
 * aceitação por um segundo agente.
 *
 * Os gates rodam DENTRO do worktree da task. Isso traz um problema prático:
 * worktree novo não tem node_modules. `prepararAmbiente` resolve com junction
 * para o node_modules do repo base — sem copiar (barato) e sem instalar de novo.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as git from './git.mjs'

/**
 * Como rodar o npm.
 *
 * Desde o fix de segurança do Node (CVE-2024-27980), `spawn` de `npm.cmd`
 * sem `shell: true` falha com EINVAL no Windows. A saída fácil seria
 * `shell: true`, mas aí os argumentos viram string de shell e um título de
 * task com aspas viraria injeção de comando.
 *
 * A saída correta: chamar o `npm-cli.js` pelo próprio node. Sem shell, sem
 * interpolação, e funciona igual em qualquer plataforma.
 */
let npmAlvo = null
function alvoNpm() {
  if (npmAlvo) return npmAlvo
  if (process.platform === 'win32') {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) {
      npmAlvo = { comando: process.execPath, prefixo: [cli] }
      return npmAlvo
    }
  }
  npmAlvo = { comando: process.platform === 'win32' ? 'npm' : 'npm', prefixo: [] }
  return npmAlvo
}

/**
 * Todos os `node_modules` de um repo, em caminho relativo à raiz.
 *
 * Um repo não tem um `node_modules`, tem vários: a raiz, `backend/`,
 * `frontend/`, `shared/types/`… O orquestrador espelha o diretório inteiro via
 * junction, então cada um precisa do seu espelho. Listar só os diretórios que
 * aparecem como `cwd` de gate não resolve: o teste de `asyncHandler` importa
 * `shared/types/node_modules/zod` de propósito, para provar que um ZodError
 * vindo de outra cópia do zod ainda vira 400.
 *
 * Não desce dentro de `node_modules` (esses são dependências aninhadas e já
 * vêm pelo junction do pai) nem segue symlink/junction, para não entrar em
 * laço.
 */
export function diretoriosNodeModules(base, profundidadeMax = 3) {
  const achados = []

  function andar(rel, profundidade) {
    if (profundidade > profundidadeMax) return
    let entradas
    try {
      entradas = readdirSync(join(base, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entradas) {
      if (e.isSymbolicLink()) continue
      if (!e.isDirectory()) continue
      const r = rel ? join(rel, e.name) : e.name
      if (e.name === 'node_modules') {
        achados.push(r)
        continue
      }
      if (e.name === '.git' || e.name === 'dist' || e.name === 'build' || e.name === 'coverage') continue
      andar(r, profundidade + 1)
    }
  }

  andar('', 0)
  return achados
}

/**
 * Em Windows, junction (symlink de diretório) em vez de cópia. `symlinkSync` com
 * 'junction' não precisa de privilégio de administrador.
 *
 * Espelha TODO `node_modules` do repo base, não só a raiz. Um repo tem um
 * `node_modules` por pacote, e o gate roda em vários deles (`backend/`), e o
 * código de teste pode importar de outro (`shared/types/`). Espelhar só a raiz
 * fazia o gate rodar num worktree sem dependência e falhar com "tsc não é
 * reconhecido" — falha de ambiente vestida de falha de código.
 */
export function prepararAmbiente(worktree, repoBase, subdirs = []) {
  const alvos = [...new Set([...diretoriosNodeModules(repoBase), ...subdirs.map((s) => join(s, 'node_modules'))])]
  const criados = []
  const ignorados = []

  for (const alvo of alvos) {
    const dir = join(worktree, alvo)
    const origem = join(repoBase, alvo)
    if (existsSync(dir)) {
      ignorados.push(`${alvo}: já existe`)
      continue
    }
    if (!existsSync(origem)) {
      ignorados.push(`${alvo}: repo base sem ${alvo}`)
      continue
    }
    mkdirSync(dirname(dir), { recursive: true })
    try {
      symlinkSync(origem, dir, 'junction')
      criados.push(alvo)
    } catch (err) {
      ignorados.push(`${alvo}: junction falhou: ${err.message}`)
    }
  }

  return { criado: criados.length > 0, criados, ignorados }
}

/** Remove junction/symlink criado por prepararAmbiente (para não vazar handle). */
export function limparAmbiente(worktree, subdirs = []) {
  let removidos = 0
  for (const alvo of [...new Set([...subdirs, ...diretoriosNodeModules(worktree)])]) {
    const dir = join(worktree, alvo)
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removidos++
    } catch {
      /* junction que não removesse é pior que vazar, mas não vale falhar o run */
    }
  }
  return removidos > 0
}

/** Subdiretórios que os gates de um componente usam como cwd. */
export function subdiretoriosDeGate(gates = []) {
  return [...new Set(gates.map((g) => g?.cwd).filter(Boolean))]
}

/**
 * Normaliza o comando de um gate para a lista de argumentos.
 *
 * O gate é declarado como argumentos do npm (`args: ['run', 'build']`), e não
 * como string: `spawnSync` com string passaria por shell, e aí um título de
 * task com aspas viraria injeção de comando. Aceitar string é só tolerância
 * para config escrito à mão.
 */
function argsDoGate(g) {
  const bruto = Array.isArray(g.args)
    ? g.args
    : Array.isArray(g.cmd)
      ? g.cmd
      : String(g.cmd || '').split(/\s+/).filter(Boolean)
  // Tolera config escrito à mão como `cmd: 'npm test'`: o "npm" é o runner,
  // não um argumento do npm-cli.
  return bruto[0] === 'npm' ? bruto.slice(1) : bruto
}

/** Nome legível do gate, para relatório e erro. */
export function rotuloDoGate(g) {
  return g.label || (Array.isArray(g.args) ? `npm ${g.args.join(' ')}` : `npm ${g.cmd}`)
}

/**
 * Executa um comando de gate e devolve evidência: exit code, stdout e stderr
 * truncados. O texto vai para o relatório porque "build passou" sem evidência
 * não é verificável por ninguém depois.
 */
export function rodarGate({ gate, cwd, timeoutMs = 15 * 60 * 1000, env = {} }) {
  const args = argsDoGate(gate)
  const { comando, prefixo } = alvoNpm()
  const iniciado = Date.now()
  const res = spawnSync(comando, [...prefixo, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env, CI: '1' },
  })
  const stdout = (res.stdout || '').slice(-8000)
  const stderr = (res.stderr || '').slice(-4000)
  return {
    nome: gate.nome,
    cmd: `npm ${args.join(' ')}`,
    ok: res.status === 0,
    exitCode: res.status,
    duracaoMs: Date.now() - iniciado,
    stdout,
    stderr,
    erroSpawn: res.error ? `${res.error.code}: ${res.error.message}` : null,
    timeout: res.error?.code === 'ETIMEDOUT',
  }
}

/**
 * Arquivos citados nas linhas de FALHA da saída do gate.
 *
 * O formato da saída é do runner de testes, e ele varia: vitest, um script
 * próprio que só imprime "FALTA: x.ts", npm, make. Casar o formato de um
 * runner deixa o resto cego — foi o que quebrou o E2E. Então a regra é a
 * inversa: descarta as linhas que dizem que deu certo e considera todas as
 * outras.
 *
 * Descartar as linhas de sucesso é o ponto. O vitest lista no resumo também
 * os arquivos que passaram (` ✓ x.test.ts`), e a versão anterior da heurística
 * varria a saída inteira: viu o nome de um arquivo que PASSOU e acusou a
 * task de ter quebrado o gate. Foi assim que a T-003 foi reprovada.
 */
function arquivosQueFalharam(stdout, stderr) {
  const texto = `${stdout || ''}\n${stderr || ''}`
  const arquivos = new Set()
  for (const linha of texto.split(/\r?\n/)) {
    const limpo = linha.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
    if (!limpo) continue
    // Linha de sucesso: o arquivo citado nela passou.
    if (/^[✓✔√]/.test(limpo)) continue
    if (/\b(passed|passing)\b/i.test(limpo)) continue
    for (const m of limpo.matchAll(/[\w.\-@/\\]+\.(?:ts|tsx|vue|js|mjs|json|md|css)/g)) {
      arquivos.add(m[0])
    }
  }
  return arquivos
}

/**
 * Atribui (ou não) a falha do gate a esta task.
 *
 * Um gate de repositório (build, suíte completa) mede o TODO o repositório,
 * mas a task é julgada sozinha, no worktree dela. Rodar `npm test` num worktree
 * que tem só a mudança da task vai falhar por causa de arquivos que a task não
 * tocou — e reprovar por isso seria falso positivo, do tipo que faz a pessoa
 * parar de confiar na revisão.
 *
 * A regra: se a falha aponta para arquivo que ESTA task alterou, é culpa dela
 * (bloqueante). Se não aponta para nenhum arquivo dela, é sinalizado como
 * aviso e a validação real acontece na integração, sobre o conjunto completo.
 *
 * Limite conhecido, e vale registrar: a atribuição é por nome de arquivo. Uma
 * task que quebra um teste cujo arquivo não tem o mesmo nome do arquivo que
 * alterou (muda `usuarios.ts` e quebra um `usuarios.test.ts` de outro módulo)
 * passa como aviso. Fechar essa brecha de vez exige comparar a suíte na base
 * contra a suíte na head.
 */
export function culpaDaTask(gate, arquivosDaTask) {
  const falharam = arquivosQueFalharam(gate.stdout, gate.stderr)
  const meus = new Set((arquivosDaTask || []).map((f) => f.toLowerCase().replace(/\\/g, '/')))
  const meusBase = new Set([...meus].map((f) => f.split('/').pop()))
  return [...falharam].some((f) => {
    const fn = f.toLowerCase().replace(/\\/g, '/')
    return meus.has(fn) || meusBase.has(fn.split('/').pop())
  })
}

/**
 * Revisão mecânica completa de uma task.
 *
 * @returns {{aprovado:boolean, criticos:string[], avisos:string[], gates:object[], evidencia:object}}
 */
export function revisar({ task, gates = [], permitirSujeira = false }) {
  const criticos = []
  const avisos = []
  const worktree = task.worktree

  if (!worktree || !existsSync(worktree)) {
    return {
      aprovado: false,
      criticos: [`Worktree não encontrado: ${worktree}`],
      avisos: [],
      gates: [],
      evidencia: {},
    }
  }

  const repo = git.commonDir(worktree)
  const base = task.baseSha || git.revParse(task.baseRef || 'HEAD', worktree)

  // 1. Houve trabalho de verdade?
  const commits = git.commitsDesde(worktree, base)
  const arquivosCommitados = git.arquivosCommitados(worktree, base)
  const sujos = git.arvoreLimpa(worktree) ? [] : git.arquivosNaoCommitados(worktree)

  if (!commits.length) {
    criticos.push('Nenhum commit na branch. A task não produziu alteração versionável.')
  }
  if (!arquivosCommitados.length && !sujos.length) {
    criticos.push('Nenhum arquivo alterado. A task não mexeu em nada.')
  }

  // 2. Árvore limpa? Sujeira é sinal de trabalho pela metade.
  if (sujos.length && !permitirSujeira) {
    criticos.push(
      `Árvore suja: ${sujos.length} arquivo(s) sem commit (${sujos.slice(0, 5).join(', ')}). ` +
        `Implementação parcial não passa como concluída.`,
    )
  }

  // 3. Escopo: o agente mexeu onde não devia?
  const foraDoEscopo = []
  if (task.arquivosAlvo?.length) {
    const alvo = task.arquivosAlvo.map((f) => f.toLowerCase().replace(/\/+$/, ''))
    for (const f of arquivosCommitados) {
      const fl = f.toLowerCase()
      if (!alvo.some((a) => fl.startsWith(a))) foraDoEscopo.push(f)
    }
    if (foraDoEscopo.length) {
      avisos.push(
        `Alterou ${foraDoEscopo.length} arquivo(s) fora do escopo declarado: ${foraDoEscopo.slice(0, 6).join(', ')}`,
      )
    }
  }

  // 4. Confiança: alteração gigante costuma ser sinal de runaway do agente.
  const totalArquivos = new Set([...arquivosCommitados, ...sujos]).size
  if (totalArquivos > 40) {
    avisos.push(`Alteração grande (${totalArquivos} arquivos). Vale conferir se não foi runaway do agente.`)
  }

  // 5. Nada de empurrar: a branch não pode estar à frente do remoto.
  const branch = task.branch
  if (branch && git.branchRemotoExiste(branch, repo)) {
    const local = git.revParse(branch, repo)
    const remoto = git.revParse(`origin/${branch}`, repo)
    if (local !== remoto) {
      avisos.push(`Branch ${branch} existe no remoto e divergiu local (${local.slice(0, 7)} vs ${remoto.slice(0, 7)}). Nenhum push foi feito pelo orquestrador.`)
    }
  }

  // 6. Gates reais.
  //
  // `preparar: true` roda antes dos demais e existe para ferramentas que
  // geram artefato a partir do código (o caso é o Prisma: o client vive dentro
  // de node_modules e precisa ser regerado quando o schema muda). Verificar
  // antes de preparar checa código novo contra artefato velho e produz erro de
  // tipo que não existe.
  const resultadosGates = []
  const preparo = gates.filter((g) => g.preparar)
  const verificacao = gates.filter((g) => !g.preparar)

  for (const [fase, lista] of [['preparar', preparo], ['verificar', verificacao]]) {
    for (const g of lista) {
      const cwd = g.cwd ? join(worktree, g.cwd) : worktree
      if (!existsSync(join(cwd, 'package.json'))) {
        const msg = `Gate "${g.nome}" pulado: ${join(g.cwd || '.', 'package.json')} não existe no worktree`
        if (g.obrigatorio) criticos.push(msg)
        else avisos.push(msg)
        resultadosGates.push({ nome: g.nome, fase, ok: null, pulado: true, motivo: msg })
        continue
      }
      const r = rodarGate({ gate: g, cwd })
      resultadosGates.push({ nome: g.nome, fase, ...r })
      if (!r.ok) {
        const ultimas = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')
        const causa = r.erroSpawn ? `falha ao rodar: ${r.erroSpawn}` : `exit ${r.exitCode}`
        const meusArquivos = [...arquivosCommitados, ...sujos]

        // Falha de preparação é sempre da task: sem o artefato, nada foi
        // verificado de verdade. Não dá para culpar "conteúdo pré-existente".
        if (fase === 'preparar') {
          criticos.push(`Preparação "${g.nome}" falhou (${causa}). Últimas linhas: ${ultimas}`)
        } else if (g.obrigatorio && culpaDaTask(r, meusArquivos)) {
          criticos.push(
            `Gate "${g.nome}" falhou (${causa}) apontando para arquivo desta task. Últimas linhas: ${ultimas}`,
          )
        } else if (g.obrigatorio) {
          avisos.push(
            `Gate "${g.nome}" falhou (${causa}), mas a falha não aponta para nenhum arquivo desta task — ` +
              `conteúdo pré-existente ou de outra task. Revalidado na integração. Últimas linhas: ${ultimas}`,
          )
        } else {
          avisos.push(`Gate "${g.nome}" falhou (${causa}). Últimas linhas: ${ultimas}`)
        }
      }
    }
  }

  const evidencia = {
    commits,
    arquivosCommitados,
    arquivosSujos: sujos,
    foraDoEscopo,
    totalArquivos,
    base,
    diffStat: git.diffEstatistico(worktree, base),
    verificacaoEm: new Date().toISOString(),
  }

  return {
    aprovado: criticos.length === 0,
    criticos,
    avisos,
    gates: resultadosGates,
    evidencia,
  }
}

/**
 * Avaliação dos critérios de aceitação.
 *
 *parte mecânica: confere se os termos aparecem no que o agente produziu
 * (commits, arquivos, resultado). É heurística e assume como evidência — não
 * prova que o comportamento existe. Por isso a segunda parte, opcional, é um
 * segundo agente que lê o diff com critério.
 */
export function avaliarCriterios({ task, revisaoMecanica, textoAgente = '' }) {
  const criterios = task.criterios || []
  if (!criterios.length) {
    return {
      avaliados: [],
      todosAtendidos: true,
      nota: 'Sem critérios declarados: aceito por evidência mecânica (commits + gates). Declare critérios para revisão semântica.',
    }
  }

  const corpus = [
    textoAgente.toLowerCase(),
    ...(revisaoMecanica?.evidencia?.commits || []).map((c) => c.mensagem.toLowerCase()),
    ...(revisaoMecanica?.evidencia?.arquivosCommitados || []).map((a) => a.toLowerCase()),
  ].join('\n')

  const avaliados = []
  for (const c of criterios) {
    // Termos significativos: palavras com 4+ letras, ignorando stopwords.
    const termos = String(c)
      .toLowerCase()
      .split(/[^a-zà-ÿ0-9]+/)
      .filter((t) => t.length >= 4 && !/^(para|com|que|não|nao|deve|ser|uma|dos|das|por|mais|sem|isso|este|esta|quando|onde|todo|toda)$/.test(t))
    const presentes = termos.filter((t) => corpus.includes(t))
    const cobertura = termos.length ? presentes.length / termos.length : 0
    avaliados.push({
      criterio: c,
      cobertura,
      evidenciado: cobertura >= 0.34,
      termosEncontrados: presentes,
    })
  }

  const todosAtendidos = avaliados.every((a) => a.evidenciado)
  const naoAtendidos = avaliados.filter((a) => !a.evidenciado).map((a) => a.criterio)

  return {
    avaliados,
    todosAtendidos,
    naoAtendidos,
    nota:
      naoAtendidos.length === 0
        ? 'Todos os critérios têm evidência textual no resultado do agente.'
        : `Sem evidência para ${naoAtendidos.length} de ${criterios.length} critérios. Isso NÃO é reprovação automática: cobertura textual é heurística. Confirme com o revisor.`,
  }
}