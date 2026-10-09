# orq — orquestrador multiagente para OpenCode

Você define as tarefas e as prioridades. O `orq` abre as sessões de agente,
isola cada uma em um worktree do Git, acompanha a execução, revisa o resultado
com testes reais e prepara a integração — parando antes de mexer na branch
principal.

Ele não é um sistema de documentação. É o que impede dois agentes de editarem a
mesma árvore, uma task de partir para código desatualizado, e um "terminei" de
agente virar entrega sem verificação.

## Como funciona, em uma linha

```
task → planeja dependências → cria worktree+branch → abre sessão do OpenCode
     → agente trabalha isolado → commita → revisão com gate real
     → integração numa branch própria → PARA (você autoriza)
```

## Requisitos

| Precisa | Versão verificada |
|---|---|
| Node.js | 20+ (testado em 24.20) |
| OpenCode | 1.18.35 |
| Git | 2.54+ |

O OpenCode precisa estar autenticado (`opencode providers`). O `orq` sobe um
`opencode serve` próprio e fala com ele pela API REST.

## Instalação

```powershell
git clone <url> C:\Users\Pablo\Desktop\orq
cd C:\Users\Pablo\Desktop\orq
node bin\orq.mjs install-agents   # instala orq-worker / orq-reviewer / orq-integrator
node bin\orq.mjs init              # confere componentes, OpenCode e agentes
```

`install-agents` grava os agentes em `~/.config/opencode/agent/`. São globais de
propósito: o orquestrador trabalha em vários repositórios (portal, chamados,
sce) e o agente precisa existir em todos.

Opcional, para não digitar `node bin\orq.mjs` sempre:

```powershell
# na pasta do orq
npm link          # deixa `orq` disponível no terminal
```

## Configuração: seus componentes

Tudo que o `orq` precisa saber sobre seus projetos está em `orq.config.mjs`,
na raiz. Copie `orq.config.exemplo.mjs`:

```js
export default {
  concurrency: 2,                       // agentes em paralelo
  worktreesDir: 'C:/Users/Pablo/Desktop/orq-worktrees',

  componentes: {
    portal: {
      repo: 'C:/Users/Pablo/Desktop/portal',
      branch: 'main',
      gates: [{ nome: 'build', args: ['run', 'build'], obrigatorio: true }],
      areas: { auth: ['04-autenticacao-e-permissoes'] },  // guia o contexto
    },
    sce: {
      repo: 'C:/Users/Pablo/Desktop/sce',
      branch: 'main',
      gates: [],
    },
  },
}
```

**`repo` é o campo que mais importa.** É ele que decide onde o worktree da task
nasce. Task que muda contrato de API precisa de worktree no repo do backend, não
no do frontend — senão o agente trabalha em outro código.

**`gates`** são os comandos que provam que a mudança funciona. Rode-os dentro do
worktree da task. São argumentos do npm, nunca string com shell: `args: ['test']`.

## Uso

```powershell
orq init                                  # verifica o ambiente

# criar tasks
orq add "Criar avaliação de chamado no backend" `
      --comp chamados --crit "rota POST /chamados/:id/avaliar" --prio 5
orq add "Mostrar a avaliação na tela do portal" `
      --comp portal --dep T-001 --arq "src/views/ChamadosView.vue"

orq plan          # decompõe, deduz dependências, mostra conflitos de arquivo
orq run           # despacha a fila (--max 3 para mais paralelismo)
orq status        # o que está em andamento, aguardando revisão, bloqueado
orq review --todos
orq integrate     # integra as aprovadas numa branch de integração e PARA
orq recover       # reidrata o estado depois de Ctrl+C ou reinício
```

### Atalho do ciclo inteiro

```powershell
orq run --revisar && orq integrate
```

## Regras que o `orq` impõe

| Regra | Como é garantida |
|---|---|
| Cada task tem branch e worktree próprios | `orq/<ID>-<slug>`, base pinado no momento do despacho |
| Agente não mexe na árvore de outro | worktree separado; o Git isola no nível do arquivo |
| Agente nunca faz `git push` | barreira no módulo Git; a operação é recusada com erro |
| `reset --hard`, `rebase`, `branch -D`, `clean` bloqueados | idem (liberados só com `allowDestructive`) |
| Task não pula etapas | máquina de estados: `em-andamento → aguardando-revisao` obrigatório |
| Task que depende de outra espera a outra ser **integrada** | scheduler |
| Duas tasks no mesmo arquivo não rodam juntas | detecção de colisão por caminho e diretório |
| Nada é aceito só porque o agente disse que terminou | revisão mecânica: commits, árvore limpa, gate real, escopo |
| main só muda com sua autorização | `orq integrate` para; só `--aplicar` aplica (fast-forward, sem push) |

## Estados

```
pendente → aguardando-dependencia → pronta → em-andamento
         → aguardando-revisao → aguardando-integracao → concluida
                     ↓
                  bloqueada / falhou
```

O estado fica em `.state/tasks.json` (escrita atômica) e o histórico em
`.state/events.jsonl`. A sessão de conversa é descartável: quem manda é o disco.

## Contexto que o agente recebe

Não é "leia o repositório". O briefing entrega:

- o diretório e a branch onde ele está, e o commit base;
- a task, os critérios de aceitação e o escopo de arquivos;
- **os capítulos de `/docs` relevantes**, filtrados por palavra-chave (a partir
  do mapa `areas` do componente);
- o que ele precisa saber da arquitetura (três backends, contrato do SCE com
  `success: false`, token em memória);
- as restrições (sem push, sem merge, escopo, commitar);
- o formato exato do relatório final.

## Trello (opcional)

Sem credencial, nada quebra — o `orq` funciona inteiro com `orq add`.

```powershell
$env:TRELLO_API_KEY = "..."     # sessão atual
$env:TRELLO_TOKEN  = "..."
$env:TRELLO_BOARD_ID = "..."
setx TRELLO_API_KEY "..."       # permanente na máquina
setx TRELLO_TOKEN  "..."

orq trello-sync --listas "Pronto,Fazendo"
```

Credencial **nunca** entra no repo. O módulo `trello.mjs` só lê o ambiente e
redige a chave/token de qualquer mensagem de erro (`ocultar()`).

O checklist do card vira subtarefa, e cada item vira uma task — card com 4 itens
é 4 tarefas, não uma.

## Testes

```powershell
npm test                  # 112 testes do próprio orquestrador
node tests\e2e.mjs        # 31 verificações de ponta a ponta, em repo descartável
node tests\e2e.mjs --com-agente   # + execução com um agente OpenCode real
```

O E2E cria um repositório git em `%TEMP%`, roda o pipeline inteiro e **não toca
em nenhum repositório de produto**. Ele prova, entre outras coisas:

- conflito de arquivo é detectado antes do despacho, não no merge;
- o arquivo criado pela task A não aparece no worktree da task B;
- a `main` continua idêntica depois de criar worktrees, commitar e integrar;
- revisão reprova task sem commit, com árvore suja, ou com gate quebrado por
  conta dela;
- a integração para e reporta quando duas branches brigam pelo mesmo arquivo.

## Limitações, ditas com clareza

- **Um gate de repositório inteiro não julga uma task sozinha.** No worktree da
  task falta o que outras tasks vão criar, então a falha é atribuída: se aponta
  para arquivo da task, reprova; se não, vira aviso e a validação de verdade
  acontece na integração, sobre o conjunto completo.
- **Os critérios de aceitação são verificados por evidência textual**, o que é
  heurístico. Para julgamento semântico, use o agente revisor:
  `opencode --agent orq-reviewer` dentro do worktree da task.
- **`chamados` e `sce` não têm gate configurado.** O `orq` não inventa
  verificação: até você declarar um gate nesses componentes, a revisão deles se
  apoia em commits e critérios.
- **Não há push automático**, por decisão. A integração para na branch; o `git
  push` é seu.
- **Um agente por worktree.** Dois agentes nunca dividem a mesma árvore.

## Estrutura

```
bin/orq.mjs              CLI
src/core/
  config.mjs             registro de componentes, gates e mapa de docs
  taskstore.mjs          estado persistente + máquina de estados
  git.mjs                worktree, branch, colisão, barreira destrutiva
  opencode.mjs           cliente da API do OpenCode + servidor detached
  planner.mjs            decomposição, dependências, conflito, risco
  scheduler.mjs          fila, ordem topológica, exclusão por colisão
  runner.mjs             briefing e ciclo de vida de uma task
  review.mjs             gates reais e atribuição de culpa
  integration.mjs        merge em ordem, gate do conjunto, parada final
  trello.mjs             import opcional
agents/                  orq-worker, orq-reviewer, orq-integrator
tests/                   unitários, integração com git real, E2E
```

## API do OpenCode usada

Extraída da spec que a versão instalada serve em `GET /doc` (não é suposição):

```
POST /session?directory=<worktree>          cria a sessão amarrada ao diretório
POST /session/{id}/message                 envia o briefing (síncrono)
POST /session/{id}/abort                   interrompe
GET  /session/{id}/diff                    diff da sessão
GET  /event?directory=<dir>                stream SSE de progresso
GET  /global/health                        readiness
```

O `directory` é **query parameter**, não vai no body. É ele que transforma o
worktree num sandbox do projeto — e é o que dá o isolamento.