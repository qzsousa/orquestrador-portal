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
import { prepararAmbiente } from './review.mjs'
import { repoDoComponente, componentesDaTask, docsRelevantes, modeloDoComponente } from './config.mjs'

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
 * O agente ainda pode estar certo se a PARADA for do orquestrador.
 *
 * Três casos, e o tratamento é o mesmo por um motivo só: em nenhum deles o
 * orquestrador vai ler o relatório.
 *
 *   - timeout       → a task já passou de `cfg.taskTimeoutMs`; o bloco de
 *                     rescue commita o que houver e manda para revisão.
 *   - cancelado     → alguém mexeu no estado (ou outro processo qualquer);
 *   - estado mudou  → `orq stop`, um `orq resume` concorrente, ou o lock.
 *
 * O que NAO e motivo para commitar e estado que não seja `em-andamento`: se a
 * task foi marcada `bloqueada` por outra via, o commit automático vira autoria
 * sobre um trabalho que ninguém pediu.
 */
function recuperavel(err, estadoAtual) {
  if (err.status === 'timeout') return true
  if (err.status === 'cancelado') return true
  return estadoAtual === 'em-andamento'
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

  // Fora do try de propósito: o caminho de timeout precisa saber onde está o
  // worktree e qual era o commit base, para salvar o trabalho em vez de
  // descartá-lo. Dentro do try, o catch não enxergaria nenhuma das duas.
  const worktree = join(cfg.worktreesDir, task.id, componentePrincipal)
  let baseShaGuardado = task.baseSha || null
  /** Motivo do abort, preenchido pelo `cancelado` quando a task muda de estado. */
  let abortado = null

  try {
    // --- 1. Ambiente isolado -------------------------------------------
    const branch = git.branchParaTask(task.id, task.titulo, cfg.branchPrefix)
    const baseRef = task.baseRef || cfg.componentes[componentePrincipal]?.branch || 'HEAD'

    if (existsSync(worktree)) {
      throw new Error(`Worktree já existe em ${worktree}. Use "orq recover" ou remova antes de reexecutar.`)
    }

    log(`[${task.id}] worktree: ${worktree}`)
    const wt = git.criarWorktree({ repo, dir: worktree, branch, baseRef })
    baseShaGuardado = wt.baseSha
    registro.etapas.push({ etapa: 'worktree', ok: true, worktree, branch, baseSha: wt.baseSha })

    const env = prepararAmbiente(worktree, repo)
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
      title: `orq ${task.id}: ${task.titulo}`,
      model: modeloDoComponente(cfg, componentePrincipal),
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
      timeoutMs: cfg.taskTimeoutMs,
      log,
      // O laço do cliente pergunta isto a cada volta. Sem ele, `orq stop` (ou um
      // `orq resume` concorrente, ou o lock) marcava a task como parada enquanto o
      // agente continuava editando o worktree por mais 45 minutos — e o commit
      // de rescue depois do timeout trazia esse trabalho junto, como se fosse
      // intencional. A sessão é abortada no mesmo instante em que a mudança de
      // estado é vista, não quando o runner percebe.
      cancelado: () => {
        if (abortado) return true
        const agora = store.obter(task.id)
        if (!agora) return true
        if (agora.estado !== 'em-andamento') {
          abortado = `task está em "${agora.estado}", não em "em-andamento"`
          return true
        }
        return false
      },
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
    if (abortado) registro.abortado = abortado
    log(`[${task.id}] FALHOU: ${err.message}`)

    // Tempo esgotado NÃO é motivo para jogar trabalho fora. O agente pode ter
    // passado 40min escrevendo codigo valido e o timeout ter chegado no meio do
    // relatorio final. Sem este bloco, a task vira `bloqueada` com centenas de
    // linhas abandonadas no worktree e o proximo `run` recomeca do zero - foi o
    // que aconteceu com T-002 e T-003: 573 e 545 linhas prontas, descartadas.
    //
    // O mesmo vale quando o ABORT foi do proprio orquestrador: o agente estava
    // no meio de um trabalho legitimo e a parada veio de fora. O que nao vale e
    // commitar quando a task ja estava em outro estado - ai ninguem pediu esse
    // trabalho e o commit automatico vira autoria sobre trabalho fantasma.
    if (worktree && existsSync(worktree) && !git.arvoreLimpa(worktree)) {
      let estadoAtual = null
      try {
        estadoAtual = store.obter(task.id)?.estado ?? null
      } catch {
        /* state indisponível: cai na regra conservadora de nao commitar */
      }
      if (recuperavel(err, estadoAtual)) {
        try {
          log(`[${task.id}] ${err.status === 'cancelado' ? 'turno abortado' : 'tempo esgotado'}, mas ha trabalho no worktree - commitando para nao perder`)
          return finalizarTask({
            cfg, store, task,
            worktree,
            baseSha: baseShaGuardado,
            textoAgente: '',
            commitForcado: null,
            registro, log,
          })
        } catch (erroFinal) {
          log(`[${task.id}] nao deu para salvar o trabalho: ${erroFinal.message}`)
        }
      } else {
        log(`[${task.id}] turno parado com a task em "${estadoAtual}" - trabalho deixado no worktree, sem commit automatico`)
      }
    }

    try {
      const atual = store.obter(task.id)
      if (atual && atual.estado === 'em-andamento') {
        const tentativas = atual.tentativa || 1
        if (tentativas >= (cfg.maxTentativas || 2)) {
          store.mudarEstado(task.id, 'falhou', { erros: [...(atual.erros || []), err.message] }, err.message)
        } else {
          store.mudarEstado(task.id, 'bloqueada', { erros: [...(atual.erros || []), err.message] }, err.message)
        }
      }
    } catch {
      /* estado já pode ter sido movido; não mascara o erro original */
    }
    return registro
  }
}

/**
 * Fecha a task depois que o agente terminou: commita o que ele deixou, recolhe
 * commits e arquivos e joga no portão de revisão.
 *
 * Extraído de `executarTask` porque a reanexão (`orq resume`) chega exatamente
 * aqui: o agente já rodou e já commitou, só falta o orquestrador voltar e fazer
 * a parte mecânica. Sem extrair, essa lógica viveria duplicada e as duas
 * cópias divergiriam — que é como revisão passa a aprovar task sem commit.
 */
function finalizarTask({ cfg, store, task, worktree, baseSha, textoAgente, commitForcado, registro, log }) {
  if (!baseSha) {
    registro.erro = 'Sem commit base conhecido: não dá para medir o que a task mudou.'
    return registro
  }
  if (!git.arvoreLimpa(worktree)) {
    const sujos = git.arquivosNaoCommitados(worktree)
    const msg = `feat(${task.id}): ${task.titulo}\n\nTask: ${task.id}\nCommitado pelo orquestrador: o agente deixou trabalho sem commit.`
    commitForcado = git.commitar(worktree, msg)
    log(`[${task.id}] commit forçado pelo orquestrador (${sujos.length} arquivo(s))`)
  }

  const commits = git.commitsDesde(worktree, baseSha)
  const arquivos = git.arquivosAfetados(worktree, baseSha)

  if (!commits.length) {
    store.mudarEstado(task.id, 'bloqueada', { arquivosAlterados: arquivos }, 'Nenhum commit após execução')
    registro.erro = 'Nenhum commit produzido. A task não alterou nada.'
    registro.fim = new Date().toISOString()
    return registro
  }

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
        reanexado: true,
      },
    },
    'Execução concluída; aguardando revisão',
  )
  registro.etapas.push({ etapa: 'commit', ok: true, commits: commits.length, commitForcado })
  registro.ok = true
  registro.fim = new Date().toISOString()
  return registro
}

/**
 * Reanexa uma task que ficou `em-andamento` porque o orquestrador morreu (Ctrl+C,
 * terminal fechado) enquanto o agente continuava working no servidor.
 *
 * O agente NÃO é redespachado: a sessão e o worktree já existem, e mandar o
 * briefing de novo faria o agente recomeçar do zero e duplicar o trabalho. Só
 * se espera o turno atual acabar e se faz a finalização mecânica.
 */
export async function reanexarTask({ cfg, store, task, client, log = () => {} }) {
  const registro = { taskId: task.id, inicio: new Date().toISOString(), ok: false, etapas: [], erro: null }

  if (!task.sessionID) {
    registro.erro = `${task.id} não tem sessão para reanexar`
    store.mudarEstado(task.id, 'bloqueada', { erros: [registro.erro] }, registro.erro)
    return registro
  }
  if (!task.worktree || !existsSync(task.worktree)) {
    registro.erro = `${task.id} não tem worktree válido`
    store.mudarEstado(task.id, 'bloqueada', { erros: [registro.erro] }, registro.erro)
    return registro
  }

  try {
    log(`[${task.id}] reanexando na sessão ${task.sessionID}`)
    // Mesma regra do runner: se a task não está mais `em-andamento`, o turno em
    // andamento no servidor é de outra execução e esperar por ele só gastaria o
    // timeout inteiro antes de alguém perceber.
    let abortado = null
    const resposta = await client.enviarPromptAguardar({
      sessionID: task.sessionID,
      timeoutMs: cfg.taskTimeoutMs,
      log,
      cancelado: () => {
        if (abortado) return true
        const agora = store.obter(task.id)
        if (!agora || agora.estado !== 'em-andamento') {
          abortado = `task está em "${agora?.estado ?? 'desconhecido'}", não em "em-andamento"`
          return true
        }
        return false
      },
    })

    const textoAgente = extrairTexto(resposta)
    const errosAgente = extrairErros(resposta)
    registro.etapas.push({ etapa: 'execucao', ok: errosAgente.length === 0, erros: errosAgente })

    if (errosAgente.length) {
      store.mudarEstado(task.id, 'bloqueada', { erros: errosAgente }, 'Agente reportou erro interno')
      registro.erro = `Agente reportou erro: ${errosAgente.join('; ')}`
      registro.fim = new Date().toISOString()
      return registro
    }

    return finalizarTask({
      cfg, store, task,
      worktree: task.worktree,
      baseSha: task.baseSha,
      textoAgente, commitForcado: null, registro, log,
    })
  } catch (err) {
    registro.erro = err.message
    registro.fim = new Date().toISOString()
    log(`[${task.id}] FALHOU na reanexão: ${err.message}`)
    return registro
  }
}

/** Pega a primeira seção markdown com o nome pedido (para o resumo no state). */
function primeiroBloco(texto, secao) {
  if (!texto) return ''
  const re = new RegExp(`###\\s*${secao}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, 'i')
  const m = texto.match(re)
  return m ? m[1].trim().slice(0, 2000) : texto.slice(0, 1000)
}