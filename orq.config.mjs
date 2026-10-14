export default {
  worktreesDir: 'C:/Users/es.pablo.sousa/Desktop/orq-worktrees',
  agentes: {
    workerModel: 'opencode/space-bunny-free',
  },
  componentes: {
    portal: {
      rotulo: 'Portal URE Leste 3 (frontend)',
      repo: 'C:/Users/es.pablo.sousa/Desktop/portal-ure',
      branch: 'main',
      gates: [{ nome: 'build', args: ['run', 'build'], obrigatorio: true }],
      docs: 'docs',
    },
    chamados: {
      rotulo: 'Backend de chamados (Node + Express + Prisma)',
      repo: 'C:/Users/es.pablo.sousa/Desktop/chamados',
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
      repo: 'C:/Users/es.pablo.sousa/Desktop/sce',
      branch: 'main',
      gates: [],
    },
    monitor: {
      rotulo: 'Serviço de ping dos DVRs (dentro do portal)',
      repo: 'C:/Users/es.pablo.sousa/Desktop/portal-ure',
      subdir: 'monitor',
      branch: 'main',
      gates: [{ nome: 'test', args: ['test'], obrigatorio: true, cwd: 'monitor' }],
    },
  },
}