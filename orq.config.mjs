export default {
  worktreesDir: 'C:/Users/Pablo/Desktop/orq-worktrees',
  agentes: {
    workerModel: 'opencode/space-bunny-free',
  },
  /**
   * Roteamento de modelo por dificuldade. SÃ³ entra aqui o que foi TESTADO
   * respondendo nesta mÃ¡quina â€” os 10 modelos gratuitos do provider `opencode`
   * estÃ£o no catÃ¡logo, mas metade nÃ£o funciona hoje:
   *
   *   space-bunny-free            OK
   *   longcat-2.5-preview-free     OK
   *   deepseek-v4.1-flash-free    OK
   *   mimo-v2.6-flash-free        OK
   *   big-pickle                   OK
   *   nemotron-3.5-lightning-free  instÃ¡vel: respondeu uma vez, depois mudo
   *   nemotron-3-ultra-free         503 upstream (Nvidia)
   *   nemotron-3.5-super-vl-free    Bad Request do provider
   *   glm-5.3-flash-free            unknown_parameter no corpo da requisiÃ§Ã£o
   *   beam-free                     sem resposta
   *
   * Isto Ã© o que a sondagem encontrou, nÃ£o uma verdade do provider: a faixa
   * gratuita muda. Antes de trocar qualquer id, teste com `orq init` (que
   * consulta o catÃ¡logo) e, melhor ainda, um prompt de sondagem â€” o catÃ¡logo
   * diz que o modelo EXISTE, nÃ£o que ele estÃ¡ respondendo hoje.
   *
   * A ordem Ã© por capacidade: tarefa fÃ¡cil Ã© ajuste de texto; tarefa difÃ­cil Ã©
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
      chamados: { dificil: 'opencode/longcat-2.5-preview-free' },
    },
  },
  /**
   * SÃ³ o filesystem, e sÃ³ sobre os worktrees. MCP de terceiro que a pessoa
   * instalar Ã  mÃ£o sobrevive ao `orq sync-mcp` â€” o orq sÃ³ remove o que ele
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
      rotulo: 'ServiÃ§o de ping dos DVRs (dentro do portal)',
      repo: 'C:/Users/Pablo/Desktop/portal',
      subdir: 'monitor',
      branch: 'main',
      gates: [{ nome: 'test', args: ['test'], obrigatorio: true, cwd: 'monitor' }],
    },
  },
}
