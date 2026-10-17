/**
 * Configuração do orquestrador.
 *
 * O conhecimento de "qual repo é qual componente" e "como se verifica cada um"
 * fica AQUI, num lugar só. Nenhum módulo adivinha caminho de repo ou comando de
 * build — se não está no registro de componentes, o orquestrador não roda.
 *
 * O usuário pode sobrescrever tudo com `orq.config.mjs` na raiz do orq, sem
 * editar este arquivo.
 */

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

export const RAIZ_ORQ = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * Registro dos componentes do seu sistema.
 *
 * Três backends, não dois: `chamados` e `sce` são repositórios separados, e o
 * `monitor` (serviço de ping dos DVRs) mora DENTRO do portal. Uma tarefa que
 * muda contrato de API precisa de worktree no repo dono do backend — por isso
 * `repo` é campo de primeira classe aqui.
 */
export const COMPONENTES_PADRAO = {
  portal: {
    rotulo: 'Portal URE Leste 3 (frontend)',
    repo: 'C:/Users/Pablo/Desktop/portal',
    branch: 'main',
    // Gate real: vue-tsc (tipos) + vite build. O portal não tem suíte de testes.
    gates: [{ nome: 'build', args: ['run', 'build'], obrigatorio: true }],
    docs: 'docs',
    areas: {
      auth: ['04-autenticacao-e-permissoes'],
      api: ['06-backends-e-endpoints'],
      arquitetura: ['02-arquitetura', '03-estrutura-do-projeto'],
      componentes: ['08-componentes-e-design-system'],
      erro: ['09-tratamento-de-erros', '07-estado-stores-composables'],
      deploy: ['10-build-deploy-ambientes'],
      rotas: ['05-rotas-e-telas'],
      manutencao: ['11-manutencao-e-checklists'],
      dvr: ['14-monitor-de-cameras-dvr'],
      chamado: ['14-fluxo-atendimento-chamado', '13-avaliacao-de-atendimento'],
      aceite: ['14-aceite-e-conclusao-pelo-tecnico'],
    },
  },
  chamados: {
    rotulo: 'Backend de chamados (Node + Express + Prisma)',
    repo: 'C:/Users/Pablo/Desktop/chamados',
    branch: 'main',
    // Três etapas de preparação, nesta ordem — e a ordem importa.
    //
    // `shared:build` primeiro: `shared/types` é um pacote COMPILADO e o
    // backend lê o `dist/api.d.ts`. Um worktree novo não tem `dist` — só o repo
    // base tem, espelhado por junction, com o contrato antigo. Sem esta etapa,
    // qualquer task que mexa no contrato falha o typecheck com "has no exported
    // member" para símbolos que existem no código: parece bug de código e é
    // ambiente faltando.
    //
    // `prisma:generate` depois, e `preparar: true`: o client gerado do Prisma
    // mora dentro de node_modules — que o orquestrador compartilha com o repo
    // base por junction. Sem regenerar, o typecheck compara código novo contra
    // tipos de schema antigo e acusa erro que não existe. O projeto já faz essa
    // etapa no Dockerfile e no render.yaml; o gate só espelha o build de
    // produção.
    //
    // Typecheck e suíte (vitest) por último: sem estes a task do backend seria
    // aceita sem nenhuma verificação automatizada.
    gates: [
      { nome: 'shared:build', args: ['run', 'build'], obrigatorio: true, cwd: 'shared/types', preparar: true },
      { nome: 'prisma:generate', args: ['run', 'prisma:generate'], obrigatorio: true, cwd: 'backend', preparar: true },
      { nome: 'typecheck', args: ['run', 'typecheck'], obrigatorio: true, cwd: 'backend' },
      { nome: 'test', args: ['test'], obrigatorio: true, cwd: 'backend' },
    ],
  },
  sce: {
    rotulo: 'Backend SCE (Node + Express + Supabase)',
    repo: 'C:/Users/Pablo/Desktop/sce',
    branch: 'main',
    gates: [],
    notas: 'Sem gate automático configurado. A verificação é do próprio backend.',
  },
  monitor: {
    rotulo: 'Serviço de ping dos DVRs (dentro do portal)',
    repo: 'C:/Users/Pablo/Desktop/portal',
    subdir: 'monitor',
    branch: 'main',
    gates: [{ nome: 'test', args: ['test'], obrigatorio: true, cwd: 'monitor' }],
  },
}

/** Mapeamento palavra-chave -> capítulos de /docs, para o briefing ser específico. */
export const PALAVRAS_CHAVE_DOCS = {
  auth: ['auth', 'login', 'senha', 'token', 'jwt', 'permiss', 'perfil', 'nivel', 'nível', 'sessao', 'sessão', 'primeiro acesso', 'sso'],
  api: ['endpoint', 'api', 'contrato', 'route', 'rota', 'payload', 'request', 'response', 'backend', 'http'],
  componente: ['component', 'modal', 'botao', 'botão', 'tabela', 'design system', 'css', 'style', 'layout', 'visual'],
  erro: ['erro', 'error', 'catch', 'toast', 'log de erro', 'timeout', 'exception', 'falha'],
  estado: ['store', 'pinia', 'ref', 'reactive', 'composable', 'estado', 'cache'],
  dvr: ['dvr', 'camera', 'câmera', 'ping', 'rede', 'monitor'],
  chamado: ['chamado', 'protocolo', 'status', 'atendimento', 'fluxo', 'tecnico', 'técnico'],
  rotas: ['rota', 'view', 'tela', 'pagina', 'página', 'menu', 'sidebar'],
  deploy: ['deploy', 'build', 'vercel', 'ambiente', 'produção', '.env'],
}

export const PADRAO = {
  concurrency: 2,
  opencode: {
    port: 4653,
    host: '127.0.0.1',
  },
  agentes: {
    worker: 'orq-worker',
    reviewer: 'orq-reviewer',
    integrator: 'orq-integrator',
    /**
     * Modelo do worker, no formato "provider/modelo" (ex.: "opencode/gemini-3.8-flash").
     * Vazio = herda o padrão global da máquina. Fixar aqui é o que permite
     * trocar de modelo quando um provedor começa a rejeitar uma requisição,
     * sem mexer no código.
     */
    workerModel: '',
  },
  /** Timeout de uma task (ms). Tarefas grandes existem; 45min é o padrão. */
  taskTimeoutMs: 45 * 60 * 1000,
  /**
   * Modelo que os agentes usam, no formato que a API do OpenCode espera:
   * `{ providerID, id }` — sem `modelID`, que é rejeitado com 400.
   *
   * Fechar o modelo não é vaidade: o endpoint de um provider pode TRAVAR no
   * meio de uma geração, sem erro e sem timeout do lado dele. Sem modelo
   * fixado, a task inteira fica pendurada até o timeout de 45min. Ver
   * `orq status`: task `em-andamento` que não cresce é provider travado.
   *
   * `null` = usa o default do servidor.
   */
  modelo: null,
  /**
   * Roteamento de modelo por DIFICULDADE da task (ver `calcularDificuldade`).
   *
   * Ordem de resolucao, do mais especifico ao mais genero:
   *   models.byCompDifficulty[componente][nivel]
   *   models.byDifficulty[nivel]        (so se preferDifficulty !== false)
   *   componentes[componente].modelo
   *   agentes.workerModel
   *   modelo                              (global)
   *   null                                (default do servidor)
   *
   * Default e `null` em tudo de proposito: sem configuracao explicita, o orq
   * se comporta como antes desta feature. Quem liga o roteamento e a pessoa,
   * em orq.config.mjs, sabendo o que o provider cobra.
   *
   * `preferDifficulty: false` inverte a preferencia: ai o modelo do COMPONENTE
   * ganha do nivel, que e o que se quer quando um componente so aceita um
   * provider especifico.
   *
   * ATENCAO — nome de modelo nao e palpite. Um id que nao existe no provider
   * nao da erro no `opencode serve`: a sessao e criada e simplesmente nunca
   * produz mensagem, e a task fica `em-andamento` para sempre. Foi assim que
   * tres modelos inventados custaram uma rodada inteira de worktree.
   *
   * E por isso o `orq init` consulta o catalogo de verdade do servidor antes
   * de avisar qualquer coisa. O snapshot abaixo e so a rede de seguranca para
   * quando o servidor nao esta no ar.
   */
  models: {
    preferDifficulty: true,
    byDifficulty: { facil: null, medio: null, dificil: null },
    byCompDifficulty: { chamados: {}, sce: {}, portal: {}, monitor: {} },
    /**
     * Modelos gratuitos do provider `opencode` que foram TESTADOS respondendo.
     *
     * NÃO é a lista de tudo que existe: é o que respondeu. O catálogo traz 10
     * ids gratuitos, e nesta máquina 5 deles falham (503 upstream, Bad Request,
     * corpo de requisição incompatível ou silêncio). Colocar aqui um id que
     * existe mas não responde seria pior que não colocar: o `orq init` pararia
     * de reclamar e a task voltaria a pendurar em silêncio.
     *
     * Consequência que fica explícita: o catálogo prova EXISTÊNCIA, não
     * SAÚDE. Um id pode estar no catálogo e estar fora do ar agora — foi assim
     * que o `nemotron-3.5-lightning-free` respondeu uma task e morreu na
     * seguinte. Verificação de saúde é prompt de sondagem, não leitura de config.
     */
    listaDeModelosGratis: [
      'opencode/space-bunny-free',
      'opencode/longcat-2.5-preview-free',
      'opencode/deepseek-v4.1-flash-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/big-pickle',
    ],
  },
  /**
   * MCPs que o `orq sync-mcp` escreve em ~/.config/opencode/opencode.jsonc.
   *
   * Por que o orq escreve no config GLOBAL e nao no worktree: o `opencode
   * serve` e um so, atende N worktrees, e le o config do usuario. Um
   * `.opencode/` por worktree tambem seria lido, alem de sujar N repositorios
   * de produto com arquivo do orq -- e cada agente poderia reconfigurar as
   * ferramentas alheias. Global e um lugar so, e versionado aqui.
   *
   * Tokens aceitos em qualquer posicao: `${worktreesDir}`, `${raiz}`,
   * `${stateDir}`, resolvidos no sync. E assim que o escopo do filesystem
   * acompanha `worktreesDir` sem caminho hardcoded no default.
   *
   * O SHAPE e o do OpenCode, nao um vocabulario nosso: `type` ("local"),
   * `command` como array (executavel + argumentos) e `disabled`. Manter isso
   * identico ao destino evita uma classe de bug — a primeira versao deste
   * arquivo escrevia `type: "stdio"` com `command` string, e o servidor
   * recusava o config INTEIRO, derrubando o OpenCode em qualquer diretorio.
   * A unica traducao e `enabled` -> `disabled`, porque "desligado" e o que a
   * pessoa escreve e "desligado" tambem e o que o orq decide.
   *
   * Default conservative de proposito: so o filesystem, e so sobre os
   * worktrees. Um agente precisa ler os arquivos da propria task; dar o repo
   * inteiro e nao dá nada.
   */
  mcp: {
    enabled: true,
    servers: {
      filesystem: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '${worktreesDir}'],
        enabled: true,
      },
      context7: {
        type: 'local',
        command: ['npx', '-y', '@upstash/context7-mcp'],
        enabled: false,
      },
      sequentialThinking: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'],
        enabled: false,
      },
      fetch: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-fetch'], enabled: false },
      git: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-git'], enabled: false },
    },
  },
  /** Teto de tentativas antes de marcar como falhou. */
  maxTentativas: 2,
  /** Onde os worktrees das tasks nascem. Fora de qualquer repo de produto. */
  worktreesDir: 'C:/Users/Pablo/Desktop/orq-worktrees',
  /** Branch prefixada por task. */
  branchPrefix: 'orq',
  /** Ramo que a integração usa para validar antes de propor merge. */
  integrationBranchPrefix: 'orq-integracao',
  componentes: COMPONENTES_PADRAO,
  trello: {
    boardId: null,
    listaProntas: null,
    /** Nomes das listas cujas cards entram na fila. */
    listas: null,
  },
}

function mesclar(base, sobreposicao) {
  if (!sobreposicao || typeof sobreposicao !== 'object') return { ...base }
  const saida = { ...base }
  for (const [k, v] of Object.entries(sobreposicao)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      saida[k] = mesclar(base[k], v)
    } else {
      saida[k] = v
    }
  }
  return saida
}

let cache = null

/** Usado pelos testes para carregar duas configs na mesma execução. */
export function limparCacheConfig() {
  cache = null
}

export async function carregarConfig() {
  if (cache) return cache
  const arquivo = join(RAIZ_ORQ, 'orq.config.mjs')
  let cfg = { ...PADRAO }
  if (existsSync(arquivo)) {
    const mod = await import(pathToFileURL(arquivo).href)
    cfg = mesclar(PADRAO, mod.default || {})
  }
  // Só define por padrão; um orq.config.mjs pode apontar para outro lugar, o que
  // é o que permite rodar o E2E num state descartável sem tocar no state real.
  cfg.stateDir = cfg.stateDir || join(RAIZ_ORQ, '.state')
  cfg.logDir = cfg.logDir || join(RAIZ_ORQ, 'logs')
  cfg.raiz = RAIZ_ORQ
  cache = cfg
  return cfg
}

/**
 * Modelo de um componente, com o global como reserva.
 *
 * `@property {string} providerID` ex.: `opencode`, `nvidia`
 * `@property {string} id` ex.: `step-5-preview-free`
 */
export function modeloDoComponente(cfg, nome) {
  const doComp = cfg.componentes[nome]?.modelo
  return doComp || cfg.modelo || null
}

/**
 * Modelo do agente de implementacao para uma task de dada dificuldade.
 *
 * `diff` e o retorno de `calcularDificuldade`; sem ele, cai no comportamento
 * antigo (componente, depois worker global, depois global). O retorno e a
 * configuracao crua: pode ser a string `"provider/modelo"` ou ja o objeto
 * `{ providerID, id }`, e quem chama (o runner) normaliza. Nao normaliza aqui
 * porque o `modeloDe` do runner ja faz isso e duas copias divergem.
 *
 * Retorna `null` = usa o default do servidor. Isso e intencional: modelo nao
 * configurado nao e erro, e sim "deixa o OpenCode escolher".
 */
export function escolherModelo(cfg, compNome, diff) {
  const base = modeloDoComponente(cfg, compNome) || cfg?.agentes?.workerModel || null

  const nivel = diff?.nivel
  if (!nivel) return base

  const porComp = cfg?.models?.byCompDifficulty?.[compNome]?.[nivel]
  if (porComp) return porComp

  // `preferDifficulty: false` = o componente manda. Para provider que so
  // aceita um modelo, é o que evita o worker cair no default do servidor e
  // tomar 400 na criacao da sessao.
  if (cfg?.models?.preferDifficulty !== false) {
    const porNivel = cfg?.models?.byDifficulty?.[nivel]
    if (porNivel) return porNivel
  }

  return base
}

/**
 * Tabela de modelos que o orq usaria, por componente e nivel. Para o `orq
 * init` mostrar a rota sem despachar nada, e para o `orq plan` deixar claro
 * antes de gastar tempo de agente.
 */
export function tabelaDeModelos(cfg) {
  const niveis = ['facil', 'medio', 'dificil']
  const comps = Object.keys(cfg?.componentes || {})
  return comps.map((comp) => ({
    componente: comp,
    porNivel: Object.fromEntries(niveis.map((n) => [n, escolherModelo(cfg, comp, { nivel: n })])),
  }))
}

/**
 * Modelos configurados que o orq não reconhece.
 *
 * `catalogo` é a lista de "provider/modelo" que o SERVIDOR disse que existem.
 * Quando vem, ela manda: é o provider quem sabe o que existe, não uma lista
 * escrita à mão. Sem ela (servidor fora do ar), cai no snapshot do config.
 *
 * Devolve avisos, nunca bloqueio. E o aviso é deliberadamente vago sobre o
 * motivo — "fora do que eu conheço" vale tanto para id que não existe quanto
 * para provider que acabou de cadastrar um modelo novo, e o orq não tem como
 * distinguir um do outro sem o próprio provider dizer.
 */
export function avisosDeModelo(cfg, catalogo) {
  const fonte = catalogo && catalogo.length ? catalogo : cfg?.models?.listaDeModelosGratis || []
  if (!fonte.length) return []
  const conhecidos = new Set(fonte)
  const vistos = new Set()
  const avisos = []
  for (const linha of tabelaDeModelos(cfg)) {
    for (const modelo of Object.values(linha.porNivel)) {
      if (!modelo || typeof modelo !== 'string' || vistos.has(modelo)) continue
      vistos.add(modelo)
      if (!conhecidos.has(modelo)) {
        avisos.push(
          `${modelo} (${linha.componente}) nao esta ${catalogo?.length ? 'no catalogo do servidor' : 'na lista que o orq conhece'}`,
        )
      }
    }
  }
  return avisos
}

/**
 * Catálogo de modelos do servidor, em "provider/modelo".
 *
 * Best-effort de propósito: se o `opencode serve` não estiver no ar, devolve
 * lista vazia e o `orq init` segue com o snapshot. Um `init` que falha porque
 * o servidor não subiu é pior do que um `init` com informação parcial.
 */
export async function catalogoDeModelos(cfg) {
  const { host, port } = cfg?.opencode || {}
  if (!host || !port) return []
  try {
    // `connection: close` não é moda: sem isso o undici segura o socket em
    // keep-alive e o Node pode imprimir tudo e não encerrar — o comando
    // "termina" mas a janela do terminal fica presa esperando ele sair.
    const r = await fetch(`http://${host}:${port}/config/providers`, {
      signal: AbortSignal.timeout(4000),
      headers: { connection: 'close' },
    })
    if (!r.ok) return []
    const j = await r.json()
    const provs = Array.isArray(j?.providers) ? j.providers : Object.values(j?.providers || {})
    const saida = []
    for (const p of provs) {
      const models = p?.models
      const ids = Array.isArray(models) ? models.map((m) => m.id) : Object.keys(models || {})
      for (const id of ids) if (id) saida.push(`${p.id}/${id}`)
    }
    return saida
} catch {
    return []
  }
}

/**
 * MCPs que seriam sincronizados, no shape do OpenCode e com os tokens
 * resolvidos.
 *
 * `sync-mcp` escreve estes em `~/.config/opencode/opencode.jsonc`. Nao abro o
 * arquivo aqui: config e um detalhe do CLI, nao do registro de componentes.
 *
 * A traducao e toda feita aqui, num lugar so:
 *   enabled  -> disabled    (nosso "desligado" e o flag dele)
 *   command  -> array       (executavel + argumentos, como o schema exige)
 *   args     -> fundido no command
 *   env      -> environment
 *
 * O resto passa direto. `env` e `args` sao aceitos na entrada por
 * conveniencia, mas nao sobrevive a saida: o que vai para o arquivo e
 * exatamente o que o OpenCode aceita.
 */
export function mcpAtivos(cfg) {
  if (cfg?.mcp?.enabled === false) return []
  const tokens = {
    worktreesDir: cfg?.worktreesDir || '',
    raiz: cfg?.raiz || '',
    stateDir: cfg?.stateDir || '',
  }
  const resolver = (v) => String(v).replace(/\$\{(\w+)\}/g, (_, k) => tokens[k] ?? `\${${k}}`)

  const saida = []
  for (const [nome, def] of Object.entries(cfg?.mcp?.servers || {})) {
    if (!def || def.enabled === false) continue

    const comando = Array.isArray(def.command) ? [...def.command] : [def.command, ...(def.args || [])]
    if (!comando.length || !comando[0]) continue

    const escrito = {
      type: def.type || 'local',
      command: comando.map(resolver),
      disabled: def.enabled === false,
    }
    if (def.type === 'remote' && def.url) escrito.url = def.url
    if (def.cwd) escrito.cwd = resolver(def.cwd)
    const ambiente = def.environment || def.env
    if (ambiente && Object.keys(ambiente).length) escrito.environment = ambiente
    if (def.timeout !== undefined) escrito.timeout = def.timeout
    if (def.headers) escrito.headers = def.headers

    saida.push({ nome, def: escrito })
  }
  return saida
}

/** Caminho absoluto do repo de um componente, validando que ele existe. */
export function repoDoComponente(cfg, nome) {
  const comp = cfg.componentes[nome]
  if (!comp) throw new Error(`Componente desconhecido: ${nome}`)
  if (!existsSync(comp.repo)) {
    throw new Error(
      `Repo do componente "${nome}" não encontrado em ${comp.repo}. ` +
        `Ajuste em orq.config.mjs.`,
    )
  }
  return comp.repo
}

/**
 * Componentes que uma task toca. Sem isso o worktree nasceria no repo errado —
 * foi o erro mais caro que um orquestrador pode cometer.
 */
export function componentesDaTask(cfg, task) {
  if (task.componentes?.length) {
    return task.componentes.filter((c) => {
      if (!cfg.componentes[c]) {
        throw new Error(`Task ${task.id} cita componente "${c}", que não existe no registro.`)
      }
      return true
    })
  }
  return ['portal']
}

/** Documentos de /docs relevantes à task, para o agente não ler o repo inteiro. */
export function docsRelevantes(cfg, task) {
  const texto = [task.titulo, task.descricao, ...(task.criterios || []), ...(task.arquivosAlvo || [])]
    .join(' ')
    .toLowerCase()

  const capitulos = new Set()
  const comps = task.componentes?.length ? task.componentes : ['portal']
  for (const c of comps) {
    const areas = cfg.componentes[c]?.areas || {}
    for (const [area, caps] of Object.entries(areas)) {
      if (PALAVRAS_CHAVE_DOCS[area]?.some((p) => texto.includes(p))) {
        for (const cap of caps) capitulos.add(cap)
      }
    }
  }
  // Sempre a visão geral e a estrutura: são o mínimo para não se perder.
  capitulos.add('01-visao-geral')
  return [...capitulos].sort()
}