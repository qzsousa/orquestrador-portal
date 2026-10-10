/**
 * Runner: o ciclo de vida de UMA task, do worktree ao portão de revisão.
 *
 * Sequência, e por quê nesta ordem:
 *   worktree+branch  -> ambiente isolado antes de qualquer leitura de código
 *   sessão          -> amarrada ao worktree (vira sandbox do projeto)
 *   briefing        -> contexto certo, sem despejar o repo inteiro no agente
 *   prompt          -> execução
 *   commit          -> agente commita; se não commitar, o orquestrador commita
 *                      (implementação não commitada é implementação perdida)
 *
 * Nada aqui faz merge nem push. A integração é outro módulo, e ela para na
 * frente do responsável.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as git from './git.mjs'
import { extrairTexto, extrairErros, extrairFerramentas } from './opencode.mjs'
import { prepararAmbiente, subdiretoriosDeGate } from './review.mjs'
import { repoDoComponente, componentesDaTask, docsRelevantes } from './config.mjs'

/**
 * Monta o briefing do agente.
 *
 * O objetivo é o oposto de "leia todos os arquivos": entregar o suficiente para
 * trabalhar sem precisar ler o projeto inteiro. Docs relevantes são citados por
 * capítulo; o resto do projeto é sob demanda.
 */
export function montarBriefing({ cfg, task, worktree, branch, baseSha, docs = [] }) {
  const comps = componentesDaTask(cfg, task)
  const rotulosComponentes = comps.map((c) => `${c} (${cfg.componentes[c]?.rotulo || c})`).join(', ')

  const criterios = (task.criterios || []).length
    ? task.criterios.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (nenhum critério declarado — ao terminar, descreva como validar o que fez)'

  const restricoes = [
    'Você está em um worktree isolado. Só este diretório é seu; outro agente está trabalhando em outro worktree do mesmo projeto.',
    'NÃO rode `git push`. Nenhuma branch daqui vai para o remoto sem autorização do responsável.',
    'NÃO rode `git merge`, `git rebase`, `git reset --hard` nem troque de branch.',
    'NÃO altere nada fora do escopo declarado abaixo sem avisar explicitamente.',
    'Trabalhe apenas nos arquivos do seu escopo. Se precisar de arquivo de outro componente, PARE e reporte — não edite.',
    'Ao terminar, deixe a árvore limpa: tudo commitado.',
    'Não crie documentação duplicando o que já existe em /docs. Atualize o capítulo existente se precisar registrar algo.',
  ].join('\n')

  const escopo = (task.arquivosAlvo || []).length
    ? task.arquivosAlvo.map((f) => `  - ${f}`).join('\n')
    : '  (não declarado — inferir pelo título/descrição e listar o que tocou)'

  const capitulos = docs.length
    ? docs.map((d) => `  - docs/${d}.md`).join('\n')
    : '  - docs/README.md (índice)'

  const comandos = []
  for (const c of comps) {
    for (const g of cfg.componentes[c]?.gates || []) {
      const onde = g.cwd ? `cd ${g.cwd} && ` : ''
      const args = Array.isArray(g.args) ? g.args.join(' ') : String(g.cmd || '')
      comandos.push(`  ${onde}npm ${args}   # gate de ${c}`)
    }
  }

  return `Você é um agente de implementação working numa task isolada de um projeto multiagente.

## Onde você está
- Diretório (worktree exclusivo seu): ${worktree}
- Branch: ${branch}
- Commit base: ${baseSha.slice(0, 12)}
- Componentes do sistema em escopo: ${rotulosComponentes}

Este worktree foi criado a partir da branch principal no commit acima. Não volte para outro lugar: tudo que você precisa está aqui.

## Task ${task.id}
${task.descricao || task.titulo}

## Critérios de aceitação
${criterios}

## Escopo de arquivos
${escopo}

## Documentação relevante (leia antes de editar)
${capitulos}

Regra de contexto: leia os capítulos acima e os arquivos do escopo. NÃO leia o projeto inteiro. Se precisar de um arquivo fora disso, leia só esse arquivo.

## O que você precisa saber sobre a arquitetura
- O sistema tem três backends e um frontend, em repositórios diferentes.
- O backend de chamados usa códigos HTTP reais (400/401/403/404/409/422).
- O SCE responde HTTP 200 com \`success: false\` em erro — no SCE, HTTP 200 não significa sucesso.
- Se sua task muda um contrato de API, isso é uma mudança de arquitetura: NÃO altere o contrato sem descrever no relatório o impacto no outro lado (frontend que consome, ou backend que serve).

## Verificação obrigatória antes de terminar
${comandos.length ? comandos.join('\n') : '  (sem gate automático configurado para este componente — rode o que o projeto oferecer)'}
Se um gate falhar, NÃO deixe quebrado: investigue e conserte, ou reporte o bloqueio com o erro exato.

## Restrições (inegociáveis)
${restricoes}

## Como reportar (seu último mensaje)
Escreva em markdown, exatamente com estas seções:

### Resumo
O que foi implementado, em 2-4 frases.

### Arquivos alterados
Lista de caminhos.

### Critérios de aceitação
Para cada critério: ATENDIDO ou NÃO ATENDIDO, com a evidência (arquivo:linha ou comando executado).

### Verificação
Comandos executados e o resultado de cada um (incluindo falha, se houve).

### Commits
Mensagem dos commits criados.

### Pendências e riscos
O que ficou fora, o que pode quebrar, o que depende de outra task.

Se NÃO conseguiu cumprir algum critério, diga NA VERDADE qual e por quê. Uma task que reporta falha é útil; uma task que reporta sucesso sem ter feito é prejudicial, porque o orquestrador vai integrá-la.`
}

/**
 * Executa uma task do início ao portão de revisão.
 * Nunca lança por falha do agente: devolve um registro e deixa o estado falar.
 */
export async function executarTask({ cfg, store, task, client, log = () => {} }) {
  const registro = {
    taskId: task.id,
    inicio: new Date().toISOString(),
    ok: false,
    etapas: [],
    erro: null,
  }

  const comps = componentesDaTask(cfg, task)
  const componentePrincipal = comps[0]
  const repo = repoDoComponente(cfg, componentePrincipal)

  try {
    // --- 1. Ambiente isolado -------------------------------------------
    const branch = git.branchParaTask(task.id, task.titulo, cfg.branchPrefix)
    const baseRef = task.baseRef || cfg.componentes[componentePrincipal]?.branch || 'HEAD'
    const worktree = join(cfg.worktreesDir, task.id, componentePrincipal)

    if (existsSync(worktree)) {
      throw new Error(`Worktree já existe em ${worktree}. Use "orq recover" ou remova antes de reexecutar.`)
    }

    log(`[${task.id}] worktree: ${worktree}`)
    const wt = git.criarWorktree({ repo, dir: worktree, branch, baseRef })
    registro.etapas.push({ etapa: 'worktree', ok: true, worktree, branch, baseSha: wt.baseSha })

    const env = prepararAmbiente(worktree, repo, subdiretoriosDeGate(cfg.componentes[componentePrincipal]?.gates || []))
    registro.etapas.push({ etapa: 'ambiente', ok: true, ...env })

    store.atualizar(task.id, { worktree, branch, baseSha: wt.baseSha, baseRef }, 'worktree-criado', {
      worktree,
      branch,
    })

    // --- 2. Sessão amarrada ao worktree ---------------------------------
    const docs = docsRelevantes(cfg, task)
    const sessao = await client.criarSessao({
      directory: worktree,
      agent: cfg.agentes.worker,
      // Sem modelo explícito a sessão herda o padrão global da máquina. Isso
      // couples o orquestrador à configuração de quem está rodando: quando o
      // modelo padrão é rejeitado pelo provedor, toda task morre pelo mesmo
      // motivo e o relatório não diz qual. Fixar aqui deixa a falha visível e
      // troca de modelo é uma linha de config, não de código.
      model: modeloDe(cfg.agentes.workerModel),
      title: `orq ${task.id}: ${task.titulo}`,
      metadata: { orqTaskId: task.id, componente: componentePrincipal },
    })
    if (!sessao?.id) throw new Error('OpenCode não devolveu sessionID ao criar a sessão')
    store.atualizar(task.id, { sessionID: sessao.id, agente: cfg.agentes.worker }, 'sessao-criada', {
      sessionID: sessao.id,
    })
    log(`[${task.id}] sessão: ${sessao.id}`)
    registro.etapas.push({ etapa: 'sessao', ok: true, sessionID: sessao.id })

    // --- 3. Briefing + execução ------------------------------------------
    const briefing = montarBriefing({
      cfg,
      task,
      worktree,
      branch,
      baseSha: wt.baseSha,
      docs,
    })

    const resposta = await client.enviarPrompt({
      sessionID: sessao.id,
      texto: briefing,
      agent: cfg.agentes.worker,
      directory: worktree,
      timeoutMs: cfg.taskTimeoutMs,
    })

    const textoAgente = extrairTexto(resposta)
    const errosAgente = extrairErros(resposta)
    const ferramentas = extrairFerramentas(resposta)
    registro.etapas.push({
      etapa: 'execucao',
      ok: errosAgente.length === 0,
      erros: errosAgente,
      ferramentas: ferramentas.length,
    })

    if (errosAgente.length) {
      store.mudarEstado(task.id, 'bloqueada', { erros: errosAgente }, 'Agente reportou erro interno')
      registro.erro = `Agente reportou erro: ${errosAgente.join('; ')}`
      return registro
    }

    // --- 4. Commitar (o agente deveria ter feito) ------------------------
    let commitForcado = null
    if (!git.arvoreLimpa(worktree)) {
      const sujos = git.arquivosNaoCommitados(worktree)
      const msg = `feat(${task.id}): ${task.titulo}\n\nTask: ${task.id}\nCommitado pelo orquestrador: o agente deixou trabalho sem commit.`
      commitForcado = git.commitar(worktree, msg)
      log(`[${task.id}] commit forçado pelo orquestrador (${sujos.length} arquivo(s))`)
    }

    const commits = git.commitsDesde(worktree, wt.baseSha)
    const arquivos = git.arquivosAfetados(worktree, wt.baseSha)

    if (!commits.length) {
      store.mudarEstado(
        task.id,
        'bloqueada',
        { arquivosAlterados: arquivos },
        'Nenhum commit após execução',
      )
      registro.erro = 'Nenhum commit produzido. A task não alterou nada.'
      return registro
    }

    // --- 5. Portão de revisão --------------------------------------------
    store.mudarEstado(
      task.id,
      'aguardando-revisao',
      {
        commits,
        arquivosAlterados: arquivos,
        resultado: {
          resumo: primeiroBloco(textoAgente, 'Resumo'),
          texto: textoAgente,
          commitForcado: Boolean(commitForcado),
        },
      },
      'Execução concluída; aguardando revisão',
    )
    registro.etapas.push({ etapa: 'commit', ok: true, commits: commits.length, commitForcado })
    registro.ok = true
    registro.fim = new Date().toISOString()
    return registro
  } catch (err) {
    registro.erro = err.message
    registro.fim = new Date().toISOString()
    log(`[${task.id}] FALHOU: ${err.message}`)
    try {
      const atual = store.obter(task.id)
      if (atual && atual.estado === 'em-andamento') {
        // Queda de transporte NÃO é falha do agente. O `opencode serve` é
        // solto: ele continua executando o agente mesmo depois de o
        // orquestrador morrer, e o agente pode commitar normalmente. Marcar
        // como bloqueada com o texto cru do erro levava a pessoa a descartar
        // trabalho que já estava pronto — que foi exatamente o que aconteceu
        // com a T-003. Aqui a task fica bloqueada mas com o motivo certo e a
        // instrução de recuperação.
        const caiu = err.status === 'transporte' || err.status === 'timeout'
        const motivo = caiu
          ? `${err.message}. O orquestrador perdeu a conexão, mas o servidor do OpenCode ` +
            `segue no ar e o agente pode ter terminado e commitado. ` +
            `Rode "orq adopt ${task.id}" para recolher o que foi feito, ` +
            `ou "orq run" para refazer do zero.`
          : err.message
        const tentativas = atual.tentativa || 1
        if (!caiu && tentativas >= (cfg.maxTentativas || 2)) {
          store.mudarEstado(task.id, 'falhou', { erros: [...(atual.erros || []), motivo] }, motivo)
        } else {
          store.mudarEstado(task.id, 'bloqueada', { erros: [...(atual.erros || []), motivo] }, motivo)
        }
      }
    } catch {
      /* estado já pode ter sido movido; não mascara o erro original */
    }
    return registro
  }
}

/**
 * "provider/modelo" -> { providerID, id }.
 *
 * O POST /session exige esse objeto e rejeita string solta com 400 — o schema
 * é `additionalProperties: false` com `id` e `providerID` obrigatórios.
 */
function modeloDe(valor) {
  if (!valor) return undefined
  if (typeof valor === 'object') return valor
  const i = String(valor).indexOf('/')
  if (i < 1) return undefined
  return { providerID: String(valor).slice(0, i), id: String(valor).slice(i + 1) }
}

/** Pega a primeira seção markdown com o nome pedido (para o resumo no state). */
function primeiroBloco(texto, secao) {
  if (!texto) return ''
  const re = new RegExp(`###\\s*${secao}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, 'i')
  const m = texto.match(re)
  return m ? m[1].trim().slice(0, 2000) : texto.slice(0, 1000)
}