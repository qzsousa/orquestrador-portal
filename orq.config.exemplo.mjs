/**
 * Configuração do orq. Copie este arquivo para `orq.config.mjs` e ajuste.
 *
 * Tudo que o orquestrador precisa saber sobre seus projetos está AQUI. Nenhum
 * módulo adivinha caminho de repositório nem comando de verificação: se não
 * estiver no registro de componentes, o orquestrador não roda.
 */

export default {
  /** Quantos agentes podem trabalhar ao mesmo tempo. */
  concurrency: 2,

  /** Onde nascem os worktrees das tasks. Fora de qualquer repo de produto. */
  worktreesDir: 'C:/Users/Pablo/Desktop/orq-worktrees',

  /** Prefixo das branches de task e de integração. */
  branchPrefix: 'orq',
  integrationBranchPrefix: 'orq-integracao',

  /** Timeout de uma task, em ms. */
  taskTimeoutMs: 45 * 60 * 1000,

  /** Tentativas antes de a task ser marcada como falhou. */
  maxTentativas: 2,

  opencode: {
    port: 4653,
    host: '127.0.0.1',
  },

  agentes: {
    worker: 'orq-worker',
    reviewer: 'orq-reviewer',
    integrator: 'orq-integrator',
    /**
     * Modelo do worker quando a dificuldade não define um. Mesmo formato de
     * `modelo`: "provider/modelo" ou { providerID, id }.
     *
     * String vazia = herda o default da máquina. Fixar aqui não é vaidade: sem
     * modelo explícito, quando o provider rejeita a requisição, todas as tasks
     * morrem pelo mesmo motivo e o relatório não diz qual modelo era.
     */
    workerModel: '',
  },

  /**
   * Roteamento de modelo por DIFICULDADE da task.
   *
   * A dificuldade é calculada por `calcularDificuldade` a partir do que a task
   * já declara (risco, critérios, arquivos, dependências, componentes) e vale
   * `facil` / `medio` / `dificil`. Ela aparece no `orq plan` antes de despachar
   * e vai escrita no briefing, então o agente também sabe o nível em que está.
   *
   * Ordem de resolução (primeiro que existir vence):
   *   byCompDifficulty[componente][nível]
   *   byDifficulty[nível]                — só se preferDifficulty !== false
   *   componentes[componente].modelo
   *   agentes.workerModel
   *   modelo                             — global
   *
   * Com tudo em `null` (o default), o orq se comporta como antes desta
   * feature: um modelo só.
   *
   * Os nomes abaixo são da faixa GRATUITA do provider `opencode`. `orq init`
   * avisa quando a config aponta para um modelo fora da lista que ele conhece
   * — aviso, não bloqueio: provider novo entra na lista depois.
   */
  models: {
    preferDifficulty: true,
    byDifficulty: {
      facil: 'opencode/space-bunny-free',
      medio: 'opencode/deepseek-v4.1-flash-free',
      dificil: 'opencode/longcat-2.5-preview-free',
    },
    /**
     * Ajuste por componente, quando um repositório merece um modelo diferente
     * do resto no mesmo nível. Vence `byDifficulty`.
     */
    byCompDifficulty: {
      chamados: { dificil: 'opencode/mimo-v2.6-flash-free' },
      sce: {},
      portal: {},
      monitor: {},
    },
  },

  /**
   * MCPs que o `orq sync-mcp` escreve em ~/.config/opencode/opencode.jsonc.
   *
   * Vai para o config GLOBAL, e não para o worktree, porque o `opencode serve`
   * é um só e atende todas as tasks: um config por worktree sujaria N
   * repositórios de produto e cada agente poderia reconfigurar as ferramentas
   * alheias.
   *
   * `orq sync-mcp` faz backup antes de escrever, preserva o que o orq não
   * gerencia, e só remove um servidor que ele mesmo criou — MCP instalado à
   * mão sobrevive a um `enabled: false`.
   *
   * Tokens aceitos em `args`: `${worktreesDir}`, `${raiz}`, `${stateDir}`.
   *
   * Default deliberadamente curto: só o filesystem, e só sobre os worktrees. Um
   * agente precisa ler os arquivos da própria task; dar o repositório inteiro
   * não acrescenta nada e amplia o que um commit errado consegue tocar.
   */
  mcp: {
    enabled: true,
    servers: {
      filesystem: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${worktreesDir}'],
        enabled: true,
      },
      // Consulta de documentação de biblioteca em tempo de escrever código.
      context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], enabled: false },
      // Raciocínio passo a passo. Carregue por task, não por padrão: é lento.
      sequentialThinking: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        enabled: false,
      },
      // Rede. Os agentes têm webfetch/websearch Negados por padrão; ligar aqui
      // ignora essa decisão, então ligue só se quiser que eles saiam da rede.
      fetch: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], enabled: false },
      // Operação de Git por ferramenta. Prático, e perigoso: um `git reset` por
      // engano em worktree alheio é exatamente o que o orquestrador existe para
      // impedir. Mantenha desligado.
      git: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'], enabled: false },
    },
  },

  /**
   * Registro dos componentes.
   *
   * `repo` decide onde o worktree da task nasce — é o campo mais importante
   * daqui. Task que muda contrato de API precisa de worktree no repo do
   * backend, não no do frontend.
   *
   * `gates` são os comandos que provam que a mudança funciona, rodados dentro
   * do worktree da task. São argumentos do npm, nunca string com shell:
   *   { nome: 'build', args: ['run', 'build'], obrigatorio: true }
   * `cwd` é relativo à raiz do repo, para projeto aninhado.
   *
   * `areas` liga palavras-chave do briefing a capítulos de /docs, para o agente
   * ler o que importa em vez de varrer o projeto inteiro.
   */
  componentes: {
    portal: {
      rotulo: 'Portal URE Leste 3 (frontend)',
      repo: 'C:/Users/Pablo/Desktop/portal',
      branch: 'main',
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
      gates: [
        // `preparar: true` roda antes dos gates que verificam. Use para
        // ferramenta que gera artefato a partir do codigo (Prisma, codegen) ou
        // para pacote compilado que outro le (o `shared/types` deste projeto:
        // o backend le o `dist/api.d.ts`, e um worktree novo nao tem `dist`).
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
    },

    monitor: {
      rotulo: 'Serviço de ping dos DVRs (dentro do portal)',
      repo: 'C:/Users/Pablo/Desktop/portal',
      subdir: 'monitor',
      branch: 'main',
      gates: [{ nome: 'test', args: ['test'], obrigatorio: true, cwd: 'monitor' }],
    },
  },

  /** Import do Trello. Sem credencial no ambiente, o comando avisa e o resto funciona. */
  trello: {
    boardId: null,
    listas: null,
  },
}