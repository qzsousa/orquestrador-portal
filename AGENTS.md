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

## Estado de execução

| Onde | O quê |
|---|---|
| `.state/tasks.json` | snapshot das tasks (fonte da verdade) |
| `.state/events.jsonl` | histórico append-only |
| `Desktop/orq-worktrees/` | worktrees isolados, fora de qualquer repo de produto |
| `logs/` | stdout/stderr do servidor OpenCode |

`.state/` e `logs/` estão no `.gitignore` e não devem ser versionados. Os
worktrees também: são clones de trabalho, não fonte.
