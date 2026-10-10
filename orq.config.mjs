/**
 * Configuração real deste orquestrador. O que estiver aqui sobrescreve os
 * padrões de src/core/config.mjs; o que faltar vem de lá.
 *
 * Este arquivo é máquina-local: caminhos e modelo valem para esta máquina.
 * orq.config.exemplo.mjs é a versão comentada, para outra pessoa montar a dela.
 */

export default {
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
