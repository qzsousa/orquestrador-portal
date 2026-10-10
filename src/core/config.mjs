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
    // Suite real (vitest) e typecheck. Sem estes, a task do backend seria
    // aceita sem nenhuma verificação automatizada.
    gates: [
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