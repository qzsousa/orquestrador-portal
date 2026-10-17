export default {
  worktreesDir: 'C:/Users/Pablo/Desktop/orq-worktrees',
  agentes: {
    workerModel: 'opencode/space-bunny-free',
  },
  /**
   * Roteamento de modelo por dificuldade. Só entra aqui o que foi TESTADO
   * respondendo nesta máquina — os 10 modelos gratuitos do provider `opencode`
   * estão no catálogo, mas metade não funciona hoje:
   *
   *   space-bunny-free            OK
   *   longcat-2.5-preview-free     OK
   *   deepseek-v4.1-flash-free    OK
   *   mimo-v2.6-flash-free        OK
   *   big-pickle                   OK
   *   nemotron-3.5-lightning-free  instável: respondeu uma vez, depois mudo
   *   nemotron-3-ultra-free         503 upstream (Nvidia)
   *   nemotron-3.5-super-vl-free    Bad Request do provider
   *   glm-5.3-flash-free            unknown_parameter no corpo da requisição
   *   beam-free                     sem resposta
   *
   * Isto é o que a sondagem encontrou, não uma verdade do provider: a faixa
   * gratuita muda. Antes de trocar qualquer id, teste com `orq init` (que
   * consulta o catálogo) e, melhor ainda, um prompt de sondagem — o catálogo
   * diz que o modelo EXISTE, não que ele está respondendo hoje.
   *
   * A ordem é por capacidade: tarefa fácil é ajuste de texto; tarefa difícil é
   * contrato/banco/auth, onde errar custa retrabalho.
   */
  models: {
    preferDifficulty: true,
    byDifficulty: {
      facil: 'opencode/space-bunny-free',
      medio: 'opencode/deepseek-v4.1-flash-free',
      dificil: 'opencode/longcat-2.5-preview-free',
    },
    byCompDifficulty: {
      // Prisma + contrato compartilhado: o mais delicado do sistema.
      chamados: { dificil: 'opencode/mimo-v2.6-flash-free' },
    },
  },
  /**
   * Só o filesystem, e só sobre os worktrees. MCP de terceiro que a pessoa
   * instalar à mão sobrevive ao `orq sync-mcp` — o orq só remove o que ele
   * mesmo escreveu. Rode: node bin/orq.mjs sync-mcp
   */
  mcp: {
    servers: {
      context7: { type: 'stdio', command: 'npx', args: ['-y','@upstash/context7-mcp'], enabled: false },
      sequentialThinking: { type: 'stdio', command: 'npx', args: ['-y','@modelcontextprotocol/server-sequential-thinking'], enabled: false },
    },
  },
  componentes: {
    portal: {
      rotulo: 'Portal URE Leste 3 (frontend)',
      repo: 'C:/Users/Pablo/Desktop/portal',
      branch: 'main',
      gates: [{ nome: 'build', args: ['run', 'build'], obrigatorio: true }],
      docs: 'docs',
    },
    chamados: {
      rotulo: 'Backend de chamados (Node + Express + Prisma)',
      repo: 'C:/Users/Pablo/Desktop/chamados',
      branch: 'main',
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
    },
    monitor: {
      rotulo: 'Serviço de ping dos DVRs (dentro do portal)',
      repo: 'C:/Users/Pablo/Desktop/portal',
      subdir: 'monitor',
      branch: 'main',
      gates: [{ nome: 'test', args: ['test'], obrigatorio: true, cwd: 'monitor' }],
    },
  },
}