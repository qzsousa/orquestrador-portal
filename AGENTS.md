# orq — orquestrador multiagente

Este repositório **não é o produto**. É a ferramenta que despacha tarefas para
agentes OpenCode isolados em worktrees. Os produtos são `Desktop/portal`,
`Desktop/chamados` e `Desktop/sce`.

Se a pessoa chegou aqui para **mexer no portal ou no backend**, ela está no
diretório errado — os worktrees de tarefa ficam em `Desktop/orq-worktrees`.

## Começando

Sempre comece por `node bin/orq.mjs status`. O estado está em `.state/` e
sobrevive a sessão, a crash e a reinício: **não dependa da conversa para saber
o que já foi feito**.

```bash
node bin/orq.mjs init                    # confere componentes, agentes e portas
node bin/orq.mjs status                  # estado de tudo
node bin/orq.mjs add "<tarefa>" --comp portal --crit "..." 
node bin/orq.mjs plan                    # dependências e conflitos previstos
node bin/orq.mjs run --max 2             # despacha a fila
node bin/orq.mjs review T-00X            # revisão com gates reais
node bin/orq.mjs integrate --aplicar     # move a main local (nunca faz push)
```

## Regras que não se negociam

**Nenhum push.** `integrate --aplicar` move a branch principal **local**. O
`git push` é sempre da pessoa, sempre com autorização explícita.

**Não contorne o gate.** Se a integração reprovar, a resposta é investigar o
motivo, não aplicar na mão. O valor do orq é exatamente a garantia de que a
mudança passou nos testes.

**Não confie em "deve estar funcionando".** Rode o gate. Já aconteceu de um
teste passar por acidente de ambiente (Prisma Client desatualizado, mock que
não se aplica) e parecer sinal de que a tarefa estava pronta.

**Agente que estoura o prazo não falhou por falta de esforço.** A task fica
`bloqueada` com o motivo real; `orq adopt` recupera o trabalho que o agente
orphan deixou commitado.

## Antes de despachar

Rodar `orq init` e conferir se as portas estão de pé. Os três backends precisam
estar no ar para os gates de verdade:

```bash
dev-restart -Port 10000 -Dir "C:\Users\Pablo\Desktop\chamados\backend" -Script "dev-entry.mjs"
dev-restart -Port 3000  -Dir "C:\Users\Pablo\Desktop\sce" -Script "server.js"
dev-restart -Port 5173  -Dir "C:\Users\Pablo\Desktop\portal" -Script "node_modules/vite/bin/vite.js"
```

O health-check do `dev-restart` só aceita 2xx, e o backend de chamados não tem
rota `/` — um 404 ali **é sinal de que subiu**, não de que falhou.

## Antes de mexer no `chamados`

```bash
cd shared/types && npm run build     # sem isso o typecheck mente
cd backend && npm run prisma:generate
```

`shared/types` é um pacote compilado: o TypeScript lê o `dist/api.d.ts`. Se o
`api.ts` é mais novo que o `dist`, os erros aparecem como "propriedade não
existe" e parecem bug de código.

## Skills: quem decide o que carrega

O orquestrador **recomenda** as skills por task, em `src/core/runner.mjs`
(`skillsSugeridas`): base pelo componente (portal, chamados, sce, monitor) mais
o que o assunto da task pede (Prisma → `postgres-patterns`, bug →
`verification-loop`, contrato → `eval-harness`, teste de tela →
`webapp-testing`, …). `coding-standards` é o piso e sempre entra.

A lista vai escrita no briefing, junto do nível de dificuldade. Ela é
recomendação, não ordem: o agente pode carregar outra, e o briefing diz isso.
O que não pode é ficar sem direção — por isso o "carregue a skill adequada"
solto foi removido dos três agentes: com 27 nomes e nenhuma ordem, o agente
carrega a primeira ou nenhuma.

## Dificuldade → modelo

`src/core/difficulty.mjs` classifica a task em `facil` / `medio` / `dificil`
somando sinais que o orq já tem (risco do planner, critérios, tamanho do
escopo, dependências, componentes, palavras de contrato/migração/auth) e
descontando quando a task é subtarefa. É heurística boba e explicável de
propósito: um número que muda o preço do workflow precisa ser auditável em
`orq plan`, não vir de uma segunda fonte de opinião.

O nível escolhe o modelo (`escolherModelo` em `config.mjs`) e vai no metadata
da sessão e no estado da task, então "por que essa task rodou com esse modelo"
tem resposta depois, sem depender de memória.

Ordem de resolução: `models.byCompDifficulty[componente][nível]` →
`models.byDifficulty[nível]` → `componentes[x].modelo` → `agentes.workerModel`
→ `modelo` → default do servidor. `preferDifficulty: false` inverte a
preferência para quem tem provider que só aceita um modelo.

Tudo em `null` = comportamento antigo, um modelo só. `orq init` mostra a
tabela effective e avisa (sem bloquear) quando a config aponta para um modelo
fora da faixa gratuita que o orq conhece.

## MCPs

`orq sync-mcp` escreve os MCPs de `orq.config.mjs` em
`~/.config/opencode/opencode.jsonc`. Vai no config **global** porque o
`opencode serve` é um só e atende todas as tasks: um config por worktree
sujaria N repositórios de produto e cada agente poderia reconfigurar as
ferramentas alheias.

O sync faz backup, preserva o que o orq não gerencia, e só remove servidor que
ele mesmo escreveu antes (`mcp._orq.gerenciados` rastreia) — MCP instalado à
mão sobrevive a `enabled: false`. Tokens `${worktreesDir}`, `${raiz}`,
`${stateDir}` são resolvidos no sync.

Default é só o filesystem, e só sobre os worktrees: um agente precisa ler os
arquivos da própria task, e dar o repositório inteiro só amplia o que um commit
errado alcança. `fetch` e `git` vêm desligados: o primeiro ignora o
`webfetch: deny` dos agentes, o segundo reintroduz o `git reset` que o
orquestrador existe para impedir.

## Estado de execução

| Onde | O quê |
|---|---|
| `.state/tasks.json` | snapshot das tasks (fonte da verdade) |
| `.state/events.jsonl` | histórico append-only |
| `Desktop/orq-worktrees/` | worktrees isolados, fora de qualquer repo de produto |
| `logs/` | stdout/stderr do servidor OpenCode |

`.state/` e `logs/` estão no `.gitignore` e não devem ser versionados. Os
worktrees também: são clones de trabalho, não fonte.

## Skills instaladas (referência)

As skills instaladas em `~/.config/opencode/skills` e `~/.config/opencode/skill`
sao descobertas pelo OpenCode e aparecem em `available_skills`. A lista
completa das skillsSugeridas do agente vem no briefing da task.

Skills relevantes por frente:
- Portal/frontend (React/Vite): `frontend-design`, `frontend-patterns`,
  `frontend-ui-ux`, `webapp-testing`, `lsp-validation`
- Backend (Node/Express/Prisma/Postgres): `backend-patterns`, `postgres-patterns`,
  `security-review`, `coding-standards`, `tdd-workflow`
- Chamados/SCE (Spring/Java): `springboot-patterns`, `springboot-security`,
  `springboot-tdd`, `springboot-verification`, `java-coding-standards`,
  `jpa-patterns`
- Qualidade/gates: `verification-loop`, `eval-harness`, `strategic-compact`
- Aprendizado/contexto: `continuous-learning`, `continuous-learning-v2`,
  `iterative-retrieval`

Lista completa das skills instaladas: `backend-patterns`, `clickhouse-io`,
`coding-standards`, `continuous-learning`, `continuous-learning-v2`,
`eval-harness`, `frontend-design`, `frontend-patterns`, `frontend-ui-ux`,
`golang-patterns`, `golang-testing`, `iterative-retrieval`,
`java-coding-standards`, `jpa-patterns`, `lsp-validation`,
`postgres-patterns`, `project-guidelines-example`, `security-review`,
`springboot-patterns`, `springboot-security`, `springboot-tdd`,
`springboot-verification`, `strategic-compact`, `tdd-workflow`,
`verification-loop`, `webapp-testing` (tambem built-in: `opencode`, `report`).

Regra: se mais de uma skill se aplica, carrega-las em paralelo; se nenhuma
se aplicar claramente, comece por `coding-standards`.
