/**
 * Cliente da API HTTP do OpenCode (`opencode serve`).
 *
 * Formatos NÃO são chute: todos foram lidos da spec OpenAPI 3.1 que a versão
 * instalada serve em `GET /doc`. O que este arquivo usa:
 *
 *   POST /session?directory=<dir>          body {agent,title,model?,permission?}  -> Session
 *   POST /session/{id}/message             body {parts:[{type:'text',text}]}     -> {info,parts}  (SÍNCRONO)
 *   POST /session/{id}/prompt_async        body idem                             -> dispara e retorna
 *   GET  /session/{id}/wait                -> estado ocioso
 *   POST /session/{id}/abort               -> interrompe
 *   GET  /session/{id}/diff                -> diff da sessão
 *   GET  /session/{id}/todo                -> todos do agente
 *   POST /session/{id}/permission/{rid}/reply -> responde uma aprovação
 *   GET  /event?directory=<dir>            -> stream SSE de progresso
 *   GET  /global/health                    -> readiness
 *
 * `directory` é QUERY PARAM em todos os endpoints — não vai no body. Foi esse
 * detalhe que permite um servidor só atender N worktrees: cada sessão nasce
 * amarrada ao seu diretório, e o OpenCode passa a tratá-la como sandbox do
 * projeto. É o que dá o isolamento.
 */

import { spawn, execFileSync } from 'node:child_process'
import { openSync, existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const PORTA_PADRAO = 4653

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

export class OpencodeError extends Error {
  constructor(mensagem, { status, body, causa } = {}) {
    super(mensagem)
    this.status = status
    this.body = body
    // Código real por trás da queda (ECONNRESET, ECONNREFUSED, ...). Sem ele o
    // diagnóstico para em "algo quebrou" e não dá para distinguir rede de
    // processo morto.
    this.causa = causa
  }
}

/** Fala com um servidor opencode já no ar. */
export class OpencodeClient {
  constructor({ host = '127.0.0.1', port = PORTA_PADRAO, fetchImpl = fetch } = {}) {
    this.base = `http://${host}:${port}`
    this.fetch = fetchImpl
  }

  async request(modo, caminho, { body, query, timeoutMs = 120000, stream = false } = {}) {
    const url = new URL(this.base + caminho)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await this.fetch(url, {
        method: modo,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: stream ? undefined : controller.signal,
      })
      if (!res.ok) {
        const texto = await res.text().catch(() => '')
        throw new OpencodeError(`${modo} ${caminho} -> HTTP ${res.status}: ${texto.slice(0, 500)}`, {
          status: res.status,
          body: texto,
        })
      }
      if (stream) return res
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('application/json')) return res.json()
      return await res.text()
    } catch (err) {
      if (err instanceof OpencodeError) throw err
      if (err.name === 'AbortError') {
        throw new OpencodeError(`${modo} ${caminho} excedeu ${timeoutMs}ms`, { status: 'timeout' })
      }
      // O undici esconde o motivo real em .cause e ainda devolve um
      // "TypeError: fetch failed" genérico. Sem desembrulhar, esse texto
      // chegava ao estado da task como se fosse culpa do agente — e não era:
      // era o orquestrador que tinha caído. O agente continuava rodando.
      const causa = err?.cause
      const codigo = causa?.code || err?.code || null
      throw new OpencodeError(
        `conexão com o servidor OpenCode caiu em ${modo} ${caminho}` +
          (codigo ? ` (${codigo})` : ''),
        { status: 'transporte', causa: codigo },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  health() {
    return this.request('GET', '/global/health', { timeoutMs: 5000 })
  }

  version() {
    return this.request('GET', '/global/health', { timeoutMs: 5000 })
  }

  /**
   * Cria sessão amarrada a um diretório. É o passo que transforma o worktree da
   * task num ambiente isolado: a sessão inteira vive dentro dele.
   */
  criarSessao({ directory, agent, title, model, permission, metadata }) {
    return this.request('POST', '/session', {
      query: { directory },
      body: { agent, title, model, permission, metadata },
      timeoutMs: 60000,
    })
  }

  /**
   * Envia o briefing e ESPERA o agente terminar.
   *
   * Não é um POST bloqueante, e essa distinção é o ponto. Um POST em
   * `/message` que espera o agente inteiro morre por volta dos 5 minutos: o
   * undici aborta por headers timeout (300s) muito antes de um agente de
   * verdade terminar, e o orquestrador registra "conexão caiu" — enquanto o
   * agente segue rodando no servidor e commita normalmente. Foi esse o defeito
   * que fez a T-003 parecer task falha do agente quando estava pronta.
   *
   * O caminho da API para trabalho longo é `prompt_async`, que devolve 204 na
   * hora. Depois é só esperar por polling, com requisições curtas que nunca
   * batem em timeout de headers.
   */
  async enviarPrompt({ sessionID, texto, agent, timeoutMs = 1800000, directory, intervaloMs = 3000 }) {
    await this.request('POST', `/session/${sessionID}/prompt_async`, {
      query: { directory },
      body: { parts: [{ type: 'text', text: texto }], agent },
      timeoutMs: 60000,
    })
    return this.esperarAgente({ sessionID, directory, timeoutMs, intervaloMs })
  }

  /**
   * Aguarda o agente terminar, por polling das mensagens.
   *
   * Terminado = a última mensagem de assistant ganhou um `finish` (ou um
   * `error`). Enquanto ela está em andamento, `finish` vem vazio.
   *
   * Um erro de rede no meio do polling não aborta a espera: um agente pode
   * levar 40 minutos e não é razoável perder o trabalho por um pico de 2
   * segundos. Só desiste depois de várias falhas seguidas.
   */
  async esperarAgente({ sessionID, directory, timeoutMs = 1800000, intervaloMs = 3000, maxFalhasConsecutivas = 5 }) {
    const limite = Date.now() + timeoutMs
    let falhasConsecutivas = 0

    while (Date.now() < limite) {
      try {
        const msgs = await this.mensagens(sessionID, directory)
        const lista = Array.isArray(msgs) ? msgs : []
        falhasConsecutivas = 0
        for (let i = lista.length - 1; i >= 0; i--) {
          const info = lista[i]?.info
          if (info?.role !== 'assistant') continue
          if (info.error || info.finish) return lista[i]
          break
        }
      } catch (err) {
        falhasConsecutivas++
        if (falhasConsecutivas >= maxFalhasConsecutivas) throw err
      }
      await dormir(intervaloMs)
    }
    throw new OpencodeError(`agente não terminou em ${Math.round(timeoutMs / 1000)}s`, { status: 'timeout' })
  }

  abortar(sessionID) {
    return this.request('POST', `/session/${sessionID}/abort`, { timeoutMs: 15000 }).catch(() => null)
  }

  esperarOcioso(sessionID, timeoutMs = 30000) {
    return this.request('GET', `/session/${sessionID}/wait`, { timeoutMs })
  }

  diff(sessionID) {
    return this.request('GET', `/session/{sessionID}/diff`.replace('{sessionID}', sessionID), {
      timeoutMs: 60000,
    })
  }

  todos(sessionID) {
    return this.request('GET', `/session/${sessionID}/todo`, { timeoutMs: 15000 }).catch(() => null)
  }

  sessao(sessionID) {
    return this.request('GET', `/session/${sessionID}`, { timeoutMs: 15000 })
  }

  /**
   * Histórico de mensagens da sessão.
   *
   * É o que torna a recuperação possível: a sessão vive dentro do `opencode
   * serve`, que é solto. Quando o `orq run` morre no meio, a sessão continua
   * existindo no servidor com tudo o que o agente produziu — inclusive o
   * resumo final. Sem este método, esse texto ficava inalcançável.
   */
  mensagens(sessionID, directory) {
    return this.request('GET', `/session/${sessionID}/message`, {
      query: { directory },
      timeoutMs: 30000,
    })
  }

  /** Último texto que o agente escreveu, ou '' se não houver. */
  async ultimoTextoDoAgente(sessionID, directory) {
    const msgs = await this.mensagens(sessionID, directory)
    const lista = Array.isArray(msgs) ? msgs : []
    for (let i = lista.length - 1; i >= 0; i--) {
      if (lista[i]?.info?.role !== 'assistant') continue
      const textos = (lista[i].parts || [])
        .filter((x) => x.type === 'text' && x.text?.trim())
        .map((x) => x.text)
      if (textos.length) return textos.join('\n\n')
    }
    return ''
  }

  responderPermissao(sessionID, requestID, resposta) {
    return this.request('POST', `/session/${sessionID}/permission/${requestID}/reply`, {
      body: resposta,
      timeoutMs: 15000,
    })
  }

  /**
   * Stream SSE de eventos. Usado só para progresso/log — a correção do fluxo
   * não depende disso, então uma queda do stream não corrompe a orquestração.
   */
  async ouvirEventos({ directory, onEvento, sinal }) {
    const url = new URL(this.base + '/event')
    if (directory) url.searchParams.set('directory', directory)
    const res = await this.fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: sinal,
    })
    if (!res.ok || !res.body) throw new OpencodeError(`Event stream: HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        // SSE separa eventos por linha em branco.
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const bruto = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const data = bruto
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('')
          if (!data) continue
          try {
            onEvento(JSON.parse(data))
          } catch {
            /* evento malformado não derruba o stream */
          }
        }
      }
    } finally {
      try {
        reader.cancel()
      } catch {}
    }
  }
}

/**
 * Ciclo de vida do `opencode serve`.
 *
 * Um servidor para todas as tasks, não um por task: subir um servidor custa
 * ~8s e carrega config/plugins. Com um só, o custo é o startup.
 */
export class OpencodeServer {
  constructor({ port = PORTA_PADRAO, stateDir, logDir, host = '127.0.0.1' } = {}) {
    this.port = port
    this.host = host
    this.stateDir = stateDir
    this.logDir = logDir
    this.pidFile = join(stateDir, 'opencode-server.json')
  }

  infoSalvo() {
    if (!existsSync(this.pidFile)) return null
    try {
      return JSON.parse(readFileSync(this.pidFile, 'utf8'))
    } catch {
      return null
    }
  }

  async estaNoAr(timeoutMs = 2500) {
    const client = new OpencodeClient({ port: this.port, host: this.host })
    try {
      await client.health()
      return true
    } catch {
      return false
    }
  }

  async garantir() {
    if (await this.estaNoAr()) return { reused: true, port: this.port }
    this.iniciar()
    const ok = await this.aguardarProntidao()
    if (!ok) throw new Error(`opencode serve não ficou pronto na porta ${this.port}`)
    return { reused: false, port: this.port }
  }

  /**
   * Spawn DETACHED com stdout/stderr em arquivo. Sem isso o processo filho
   * segura os handles do shell pai e a sessão do agente trava esperando EOF
   * de um processo que nunca termina.
   */
  iniciar() {
    mkdirSync(this.logDir, { recursive: true })
    mkdirSync(this.stateDir, { recursive: true })
    const out = openSync(join(this.logDir, `opencode-serve-${this.port}.log`), 'a')
    const err = openSync(join(this.logDir, `opencode-serve-${this.port}.err.log`), 'a')

    const child = spawn(
      'opencode',
      ['serve', '--port', String(this.port), '--hostname', this.host],
      { detached: true, stdio: ['ignore', out, err], windowsHide: true },
    )
    child.unref()
    writeFileSync(
      this.pidFile,
      JSON.stringify({ pid: child.pid, port: this.port, host: this.host, iniciadoEm: new Date().toISOString() }, null, 2),
    )
    return child.pid
  }

  async aguardarProntidao({ tentativas = 40, esperaMs = 1000 } = {}) {
    for (let i = 0; i < tentativas; i++) {
      if (await this.estaNoAr()) return true
      await new Promise((r) => setTimeout(r, esperaMs))
    }
    return false
  }

  /** Derruba o servidor. `taskkill /T` porque o Bun cria filho. */
  parar() {
    const info = this.infoSalvo()
    if (info?.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        /* já morreu */
      }
    }
    try {
      unlinkSync(this.pidFile)
    } catch {}
  }
}

/**
 * Extrai o texto da resposta de uma mensagem. A resposta é a união de parts;
 * texto é o que interessa para o briefing e para o relatório final.
 */
export function extrairTexto(resposta) {
  const parts = resposta?.parts || []
  return parts
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
    .map((p) => p.text || '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Parts que registraram erro — sinal de task que vai falhar. */
export function extrairErros(resposta) {
  const erros = []

  // Falha no nível da mensagem, não de uma part. Ocorre quando o agente nem
  // chegou a produzir ferramenta nenhuma: provedor devolvendo HTTP 400,
  // autenticação, modelo inexistente. Sem olhar aqui, `extrairErros` devolvia
  // lista vazia e o orquestrador concluía "a task não alterou nada" — que é
  // falso. O agente não falhou em codar; ele nunca chegou a rodar.
  const erroMsg = resposta?.info?.error
  if (erroMsg) {
    const d = erroMsg.data || erroMsg
    const status = d.statusCode ? ` (HTTP ${d.statusCode})` : ''
    erros.push(`agente: ${erroMsg.name || 'erro'}${status}: ${d.message || d}`)
  }

  const parts = resposta?.parts || []
  for (const p of parts) {
    if (p?.state?.status === 'error' && p.state.error) {
      erros.push(String(p.state.error?.data?.message || p.state.error?.name || p.state.error))
    }
    if (p?.type === 'error' && p.error) erros.push(String(p.error))
  }
  return erros
}

/** Tool calls executadas — vira a lista de ações para o relatório. */
export function extrairFerramentas(resposta) {
  const parts = resposta?.parts || []
  const out = []
  for (const p of parts) {
    if (p?.type === 'tool' && p.tool) {
      out.push({ ferramenta: p.tool, estado: p.state?.status || 'desconhecido' })
    }
  }
  return out
}