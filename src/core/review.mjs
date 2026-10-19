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

import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as git from './git.mjs'
import { prepararWorktree, limparWorktree } from './preparar-worktree.mjs'

/**
 * Todos os `node_modules` de um repo, em caminho relativo a raiz.
 *
 * Um repo nao tem UM `node_modules`, tem varios: a raiz, `backend/`,
 * `frontend/`, `shared/types/`... O orquestrador espelha o diretorio inteiro via
 * junction, entao cada um precisa do seu espelho. Listar so os diretorios que
 * aparecem como `cwd` de gate nao resolve: o teste de `asyncHandler` importa
 * `shared/types/node_modules/zod` de proposito, para provar que um ZodError
 * vindo de outra copia do zod ainda vira 400.
 *
 * Nao desce dentro de `node_modules` (esses sao dependencias aninhadas e ja
 * vem pelo junction do pai) nem segue symlink/junction, para nao entrar em laco.
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

/** Subdiretorios que os gates de um componente usam como cwd. */
export function subdiretoriosDeGate(gates = []) {
  return [...new Set(gates.map((g) => g?.cwd).filter(Boolean))]
}

/**
 * Prepara o ambiente de um worktree.
 *
 * A implementacao mora em `preparar-worktree.mjs`, e nao aqui, porque ela e
 * compartilhada com a integracao -- que precisa do mesmo ambiente, pelas mesmas
 * razoes, e que ja falhava exatamente como o runner falhava. Ter duas copias
 * garantiria que uma delas se desfaz.
 *
 * Alem de espelhar todo `node_modules` por pacote, ela religa a dependencia
 * `file:` para DENTRO do worktree e compila o pacote local. Sem o religamento,
 * o gate `shared:build` compila um `dist` do worktree que NINGUEM consome,
 * porque o `@shared/api` continua apontando para a arvore base -- e o typecheck
 * continua lendo o contrato antigo. As duas metades so funcionam juntas.
 *
 * O terceiro argumento aceita as duas formas em uso: um array de subdiretorios
 * (o que o runner e o `tools/preparar-worktree.mjs` passam) ou um objeto de
 * opcoes. O retorno tem a forma antiga (`criado`/`criados`/`ignorados`) mais os
 * campos novos, para nenhum dos dois lados quebrar.
 */
export function prepararAmbiente(worktree, repoBase, subdirsOuOpcoes = []) {
  const opcoes = Array.isArray(subdirsOuOpcoes) ? { subdirs: subdirsOuOpcoes } : subdirsOuOpcoes
  const r = prepararWorktree({ worktree, repoBase, ...opcoes })
  return {
    ...r,
    criado: r.pacotes.some((p) => p.criado),
    criados: r.pacotes.filter((p) => p.criado).map((p) => p.dir),
    ignorados: [
      ...r.pacotes.filter((p) => !p.criado).map((p) => `${p.dir}: ${p.motivo}`),
      ...r.problemas,
    ],
  }
}

/**
 * Limpa o ambiente, devolvendo o que NAO conseguiu remover em vez de engolir.
 *
 * O segundo argumento e o repo base (string) quando o chamador quer a limpeza
 * completa por pacote, ou a lista de subdiretorios (array) no uso legado. Os
 * dois tipos se distinguem, e a distincao mora aqui porque as duas chamadas vem
 * de codigo escrito em momentos diferentes.
 */
export function limparAmbiente(worktree, repoBaseOuSubdirs = null, opcoes = {}) {
  if (Array.isArray(repoBaseOuSubdirs) || repoBaseOuSubdirs === null) {
    const subdirs = Array.isArray(repoBaseOuSubdirs) ? repoBaseOuSubdirs : []
    const falhas = []
    let quantos = 0
    for (const alvo of [...new Set([...subdirs, ...diretoriosNodeModules(worktree)])]) {
      const dir = join(worktree, alvo)
      if (!existsSync(dir)) continue
      try {
        rmSync(dir, { recursive: true, force: true })
        quantos++
      } catch (err) {
        falhas.push(`${alvo}: ${err.message}`)
      }
    }
    return { removido: quantos > 0, falhas }
  }
  return limparWorktree({ worktree, repoBase: repoBaseOuSubdirs, ...opcoes })
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
 * Como executar o npm sem shell.
 *
 * `rodarGate` usa `shell: false` de propósito — título de gate pode vir de
 * config escrita à mão, e shell transforma argumento em comando. No Windows
 * isso colide com o npm: `npm` no PATH é `npm.cmd`, um batch, e CreateProcess
 * não executa batch. O sintoma é ENOENT num gate que "deveria" funcionar, e a
 * tentação natural é virar para `shell: true` — que é exatamente o que o resto
 * do orquestrador evita.
 *
 * A saída é rodar o `npm-cli.js` com o próprio node: `{ comando: node,
 * prefixo: [npm-cli.js] }`. É o mesmo truque de `comandoOpencode` em
 * opencode.mjs, e por isso as duas funções existem.
 *
 * `exportada` porque gate é a prova de que a mudança funciona: se isto
 * quebrar, o orchestrator aprova task sem nunca ter rodado o build.
 */
export function alvoNpm() {
  if (process.platform !== 'win32') return { comando: 'npm', prefixo: [] }
  try {
    const candidatos = execFileSync('where', ['npm'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    // `npm.cmd` é um shim que chama npm-cli.js. Achando o cli, o node roda
    // direto e o problema de batch some.
    const cmd = candidatos.find((c) => c.toLowerCase().endsWith('.cmd'))
    if (cmd) {
      const raiz = cmd.replace(/\\npm\.cmd$/i, '')
      for (const rel of [
        '\\node_modules\\npm\\bin\\npm-cli.js',
        '/node_modules/npm/bin/npm-cli.js',
      ]) {
        const cli = raiz + rel
        if (existsSync(cli)) return { comando: process.execPath, prefixo: [cli] }
      }
    }
    // Shim do próprio node install: C:\Program Files\nodejs\node_modules\npm\bin
    const exe = candidatos.find((c) => c.toLowerCase().endsWith('node.exe'))
    if (exe) {
      const base = exe.replace(/\\node\.exe$/i, '')
      for (const rel of ['\\node_modules\\npm\\bin\\npm-cli.js', '/node_modules/npm/bin/npm-cli.js']) {
        const cli = base + rel
        if (existsSync(cli)) return { comando: process.execPath, prefixo: [cli] }
      }
    }
  } catch {}
  return { comando: 'npm', prefixo: [] }
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
  // Falha que é da máquina, não da task. Não reprova, mas também não some:
  // uma revisão que aprova calada com um gate que não rodou é pior que reprovar.
  const criticosAmbientais = []
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

        // Arquivo travado por outro processo não é defeito da task. Reprovar
        // aqui obriga a desligar o backend e rodar de novo sem ninguém saber
        // por quê — e a task está ótima.
        const ambiente = falhaDeAmbiente({ ...r, nome: g.nome, fase })
        if (ambiente) {
          criticosAmbientais.push(`${ambiente.gate}: ${ambiente.causa} ${ambiente.remedy}`)
          avisos.push(`Gate "${g.nome}" falhou por ambiente, não pela task. ${ambiente.causa}`)
          continue
        }

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
    // Vai para a tela e para o log junto da aprovação: `aprovado: true` com
    // esta lista cheia significa "a task passou, e este gate não rodou por
    // causa da máquina". Quem lê precisa ver as duas coisas.
    criticosAmbientais,
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
/**
 * Arquivos que um critério nomeia.
 *
 * Critério de aceitação costuma dizer ONDE a coisa tem que estar: "publicar o
 * campo em CAMPOS_PUBLICAVEIS, src/routes/auth.ts:72-91". Isso é aproveitável
 * mecanicamente e a revisão não usava: ela só contava palavra sobreposta com o
 * relatório do agente e com as mensagens de commit.
 *
 * O que aconteceu: a T-003 aprovou com os 4 gates verdes e 5 de 8 critérios
 * sem cobertura textual, sendo dois deles claramente não feitos — publish
 * points em auth.ts e usuarios.ts e o arquivo de teste. Os testes antigos
 * continuavam verdes, então o gate não viu. Ler o diff viu: nenhum dos
 * arquivos nomeados tinha sido tocado.
 *
 * Não é prova de que o critério falhou — o arquivo pode já estar certo. É
 * prova de que ninguém olhou. Por isso o sinal é "arquivo nomeado e não
 * tocado", que é objetivo, e não "critério não atendido".
 */
/**
 * O critério está mandando MUDAR o arquivo, ou só usando como referência?
 *
 * Sem essa distinção o sinal de "arquivo nomeado e não tocado" vira ruído, e
 * ruído treina a pessoa a ignorar o sinal. Aconteceu na T-004: sete critérios
 * acusados porque citam `escolas.ts`, `dashboard.ts`, `middleware/auth.ts` e
 * `zodError.ts` como PADRÃO A COPIAR — "copiando a estrutura de", "usando a
 * lógica que já existe em", "reusando requireRole de". Nenhum deles devia ser
 * tocado, e nenhum foi.
 *
 * A lista é curta e declarativa de propósito: tentativa de ler o português
 * inteiro aqui produziria mais erro que acerto. O padrão que falha é
 * conservatism — se houver dúvida, o arquivo é tratado como mudança.
 */
const CITACAO_COMO_REFERENCIA =
  /\b(copi\w*|no mesmo estilo|padr(ã|a)o de|como refer(ê|e)ncia|reusando|reaproveit\w*|ja existe|já existe|mesmo caminho|mesmo padrao|mesmo padrão)\b/i

/**
 * "responder com isZodError de src/utils/zodError.ts", "usar requireRole de
 * src/middleware/auth.ts": o caminho vem depois de um identificador e de um
 * "de", o que descreve referência e não mudança. Sem isto, os critérios do
 * próprio orq acusam arquivos que nunca deveriam ser tocados.
 */
const REFERENCIA_APOS_IDENTIFICADOR = /\bcom\s+[\w$.]+\s+de\s/i

/**
 * Arquivos que um critério nomeia.
 *
 * Só entra aqui o que o critério manda MUDAR. Arquivo citado como referência
 * volta vazio de propósito: acusar "não tocou" num arquivo que era só exemplo
 * seria trocar um silêncio ruim por um alarme ruim.
 */
export function arquivosDoCriterio(criterio) {
  const out = new Set()
  const texto = String(criterio || '')
  if (CITACAO_COMO_REFERENCIA.test(texto) || REFERENCIA_APOS_IDENTIFICADOR.test(texto)) return []
  // O diretório é opcional: `schema.prisma` e `package.json` são menções
  // legítimas de arquivo. O que separa arquivo de palavra é a extensão — por
  // isso `backend/prisma`, que não tem nenhuma, não entra.
  const re = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|mjs|cjs|vue|prisma|sql|css|json|md)\b/g
  for (const m of texto.match(re) || []) {
    const limpo = m.replace(/[.,;:)]+$/, '')
    // Descarta o que for só diretório: "backend/prisma" não é um arquivo.
    if (!/\.[a-z0-9]+$/i.test(limpo)) continue
    const norm = limpo.toLowerCase()
    // Artefato gerado não faz parte de diff nenhum. O critério cita
    // "dist/api.d.ts velho" para explicar um erro de typecheck, não para pedir
    // que alguém edite o dist.
    if (/(^|\/)(dist|build|node_modules|coverage)\//.test(norm)) continue
    out.add(norm)
  }
  return [...out]
}

/** Arquivos que a task de fato tocou, normalizados para comparar com o critério. */
export function arquivosTocados(revisaoMecanica) {
  const todos = [
    ...(revisaoMecanica?.evidencia?.arquivosCommitados || []),
    ...(revisaoMecanica?.evidencia?.arquivosNaoCommitados || []),
    ...(revisaoMecanica?.evidencia?.arquivos || []),
  ]
  const set = new Set()
  for (const a of todos) {
    const limpo = String(a).replace(/\\/g, '/').replace(/^[.\/]+/, '').toLowerCase()
    set.add(limpo)
    // O diff sai do repo do componente ("backend/src/routes/auth.ts") e o
    // critério costuma citar relativo ao repo ("src/routes/auth.ts"). Guardar os
    // dois desempata a comparação.
    const i = limpo.indexOf('/')
    if (i >= 0) set.add(limpo.slice(i + 1))
  }
  return set
}

/**
 * Falha que é do AMBIENTE, não da task.
 *
 * `prisma generate` reescreve o query engine dentro de `node_modules`, e o
 * worktree compartilha esse diretório com o repo base. Com o backend de dev no
 * ar, o Windows trava o DLL e o comando morre com EPERM ao renomear. Isso
 * aconteceu quatro vezes numa sessão, e cada vez REPROVOU a task — o que é
 * mentira: a task está ótima e o gate nem chegou a olhar o código dela.
 *
 * Reprovar aqui obriga a pessoa a desligar o servidor e rodar de novo, sem
 * nenhuma pista de por quê. O sinal é específico de propósito: EPERM/EBUSY ao
 * renomear o engine do Prisma é arquivo em uso no Windows, e nada que a task
 * escreva muda isso.
 */
export function falhaDeAmbiente(g) {
  if (!g || g.ok) return null
  if (g.fase !== 'preparar') return null
  const texto = `${g.stdout || ''}\n${g.stderr || ''}`
  const prismaTravado = /query_engine[\w.-]*\.dll\.node|query_engine-windows/i.test(texto)
  const arquivoEmUso = /\b(EPERM|EBUSY)\b/i.test(texto) && /rename|unlink/i.test(texto)
  if (!prismaTravado || !arquivoEmUso) return null
  return {
    gate: g.nome,
    causa:
      'O backend de dev está segurando o DLL do Prisma. O worktree compartilha node_modules com o repo base, ' +
      'e o prisma generate não consegue renomear query_engine-windows.dll.node com o servidor no ar.',
    remedy: 'Pare o backend (dev-restart para subir de novo), rode o gate de novo. Nada a corrigir na task.',
  }
}

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

  const tocados = arquivosTocados(revisaoMecanica)

  const avaliados = []
  for (const c of criterios) {
    // Termos significativos: palavras com 4+ letras, ignorando stopwords.
    const termos = String(c)
      .toLowerCase()
      .split(/[^a-zà-ÿ0-9]+/)
      .filter((t) => t.length >= 4 && !/^(para|com|que|não|nao|deve|ser|uma|dos|das|por|mais|sem|isso|este|esta|quando|onde|todo|toda)$/.test(t))
    const presentes = termos.filter((t) => corpus.includes(t))
    const cobertura = termos.length ? presentes.length / termos.length : 0
    const arquivos = arquivosDoCriterio(c)
    const arquivosIntactos = arquivos.filter((a) => {
      if (tocados.has(a)) return false
      // O critério cita o caminho pela cauda, o diff traz o caminho inteiro:
      // "<timestamp>_add_cor_usuario/migration.sql" é o mesmo arquivo que
      // "backend/prisma/migrations/2026.../migration.sql". Comparar só igualdade
      // acusaria de falso positivo o arquivo que a task acabou de criar.
      return ![...tocados].some((t) => t.endsWith('/' + a) || t === a || t.endsWith(a))
    })
    avaliados.push({
      criterio: c,
      cobertura,
      evidenciado: cobertura >= 0.34,
      termosEncontrados: presentes,
      arquivos,
      arquivosNaoTocados: arquivosIntactos,
    })
  }

  const todosAtendidos = avaliados.every((a) => a.evidenciado)
  const naoAtendidos = avaliados.filter((a) => !a.evidenciado).map((a) => a.criterio)
  // Sinal forte e mecânico: o critério aponta um arquivo, e a task não tocou
  // esse arquivo. Cobertura textual baixa é ruído; arquivo intocado é fato.
  const comArquivoIntacto = avaliados.filter((a) => a.arquivosNaoTocados.length)

  const notas = []
  notas.push(
    naoAtendidos.length === 0
      ? 'Todos os critérios têm evidência textual no resultado do agente.'
      : `Sem evidência para ${naoAtendidos.length} de ${criterios.length} critérios. Isso NÃO é reprovação automática: cobertura textual é heurística. Confirme com o revisor.`,
  )
  if (comArquivoIntacto.length) {
    notas.push(
      `ATENÇÃO: ${comArquivoIntacto.length} critério(s) citam arquivo que a task não tocou — ` +
        `${comArquivoIntacto.map((a) => a.arquivosNaoTocados.join(', ')).join(' | ')}. ` +
        'Gates verdes não cobrem isso: os testes antigos continuam passando com o trabalho por fazer. Confira se o critério foi cumprido.',
    )
  }

  return {
    avaliados,
    todosAtendidos,
    naoAtendidos,
    arquivosNaoTocados: comArquivoIntacto.map((a) => a.arquivosNaoTocados),
    nota: notas.join(' '),
  }
}