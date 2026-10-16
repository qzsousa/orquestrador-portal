/**
 * Configuração real deste orquestrador. O que estiver aqui sobrescreve os
 * padrões de src/core/config.mjs; o que faltar vem de lá.
 *
 * Este arquivo é máquina-local: caminhos e modelo valem para esta máquina.
 * orq.config.exemplo.mjs é a versão comentada, para outra pessoa montar a dela.
 */

export default {
  worktreesDir: 'C:/Users/es.pablo.sousa/Desktop/orq-worktrees',

  /**
   * Caminhos reais desta máquina. O `src/core/config.mjs` assume
   * `C:/Users/Pablo/Desktop/...`, que não existe aqui — e o frontend do portal
   * chama-se `portal-ure`, não `portal`.
   */
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

  agentes: {
    /**
     * Modelo do worker, no formato "provider/modelo".
     *
     * Fixar o modelo não é vaidade: sem isto a sessão herda o modelo padrão
     * global da máquina, e o OpenCode foi parar numa rota de provedor que
     * rejeita a requisição com "Validation: Unsupported parameter(s):
     * `permissions`" (HTTP 400). Com o modelo explícito a chamada passa.
     *
     * Sem valor aqui, toda task morre com o mesmo erro e o relatório aponta
     * para a tarefa em vez de apontar para a configuração.
     */
    workerModel: 'opencode/space-bunny-free',
  },
}
