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

export class OpencodeError extends Error {
  constructor(mensagem, { status, body } = {}) {
    super(mensagem)
    this.status = status
    this.body = body
  }
}

/**
 * Autenticação do servidor.
 *
 * O `opencode serve` só exige auth quando `OPENCODE_SERVER_PASSWORD` está no
 * ambiente — e o OpenCode Desktop deixa a variável lá para o desktop falar com
 * o servidor. Aí `orq run` sobe o próprio `opencode serve`, o filho herda a
 * variável e responde 401 em TUDO, inclusive em `/global/health`. Sem este
 * header o orquestrador concluiria que o servidor não subiu e reclamaria de
 * timeout, que é a mensagem errada para a causa real.
 *
 * A credencial nunca sai do ambiente: lemos as duas variáveis e montamos o
 * Basic. Ela não vai para log, nem para o estado, nem para o repo.
 */
function cabecalhoAuth() {
  const senha = process.env.OPENCODE_SERVER_PASSWORD
  if (!senha) return null
  const usuario = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  return `Basic ${Buffer.from(`${usuario}:${senha}`).toString('base64')}`
}

/** 401/403 tem conserto próprio; sem isto a mensagem seria só o status. */
function ehAuth(status) {
  return status === 401 || status === 403
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
    const headers = {}
    const auth = cabecalhoAuth()
    if (auth) headers.authorization = auth
    if (body) headers['content-type'] = 'application/json'
    try {
      const res = await this.fetch(url, {
        method: modo,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: stream ? undefined : controller.signal,
      })
      if (!res.ok) {
        const texto = await res.text().catch(() => '')
        if (ehAuth(res.status) && !auth) {
          throw new OpencodeError(
            `${modo} ${caminho} -> HTTP ${res.status}: o servidor exige autenticação e nenhuma foi enviada.`,
            {
              status: res.status,
              body: texto,
              dica:
                'Defina OPENCODE_SERVER_USERNAME e OPENCODE_SERVER_PASSWORD no ambiente do orq, ' +
                'iguais às do opencode que ele vai subir.',
            },
          )
        }
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
      if (err.name === 'AbortError') {
        throw new OpencodeError(`${modo} ${caminho} excedeu ${timeoutMs}ms`, { status: 'timeout' })
      }
      throw err
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
 * Só ESPERA um turno já em andamento terminar. Não envia nada.
 *
 * Usado pela reanexão: quando o orquestrador morre no meio, o agente continua
 * working no servidor e o turno segue lá. Reanexar é voltar a olhar, não
 * mandar o briefing de novo.
 */
async enviarPromptAguardar({ sessionID, timeoutMs = 1800000, intervaloMs = 3000, log = () => {}, cancelado }) {
    const limite = Date.now() + timeoutMs
    while (Date.now() < limite) {
      if (cancelado?.()) {
        throw new OpencodeError(`Turno abandonado: ${cancelado.motivo || 'a task mudou de estado'}`, { status: 'cancelado' })
      }
      const mensagens = await this.request('GET', `/session/${sessionID}/message`, { timeoutMs: 30000 })
      const ultima = mensagens?.[mensagens.length - 1]
      if (!ultima || ultima.info?.role !== 'assistant') {
        await new Promise((r) => setTimeout(r, intervaloMs))
        continue
      }
      if (ultima.info?.time?.completed) return ultima
      log(`      ${ultima.info.id} ainda trabalhando (${ultima.parts?.length ?? 0} parts)`)
      await new Promise((r) => setTimeout(r, intervaloMs))
    }
    throw new OpencodeError(`Agente não terminou em ${Math.round(timeoutMs / 1000)}s`, { status: 'timeout' })
  }

/**
 * Envia o briefing e espera o agente terminar.
 *
 * Não dá para usar o `POST /session/{id}/message` síncrono aqui. Ele segura a
 * conexão sem mandar nenhum byte até o agente acabar, e o `fetch` do Node mata
 * a requisição por `headersTimeout` — 300s por padrão no undici. Uma task de5
 * minutos morre com `fetch failed` mesmo com o `AbortController` do orq em
 * 45min: quem corta é a camada HTTP, não a nossa. Foi o que reprovou a primeira
 * rodada com as três tasks, todas no mesmo milissegundo.
 *
 * A saída é `prompt_async` (204, não bloqueia) + polling de `GET /messages`.
 * Cada requisição é curta, então o timeout de header nunca entra. O turno
 * acabou quando a última mensagem de assistant tem `time.completed` — enquanto
 * estiver vazio, o agente ainda está trabalhando.
 *
 * `agent` não vai no corpo: a sessão já foi criada com ele, e repetir o campo
 * faz o OpenCode resolver de novo a config do agente — o bloco `permissions`
 * do frontmatter entra no request ao provider, e quem não conhece esse
 * parâmetro responde 400 (`Unsupported parameter(s): 'permissions'`).
 *
 * `cancelado()` é consultado a cada volta do laço. Parar de ESPERAR não é o
 * bastante: o agente continua escrevendo no worktree do servidor, e a task pode
 * já estar bloqueada ou cancelada — resultado é trabalho num worktree que ninguém
 * vai revisar, commitado por um runner que achou que tinha parado. Quem detecta
 * a mudança de estado é o chamador; quem corta o turno é este `POST .../abort`.
 */
async enviarPrompt({ sessionID, texto, timeoutMs = 1800000, intervaloMs = 3000, log = () => {}, cancelado }) {
    await this.request('POST', `/session/${sessionID}/prompt_async`, {
      body: { parts: [{ type: 'text', text: texto }] },
      timeoutMs: 60000,
    })

    const limite = Date.now() + timeoutMs
    while (Date.now() < limite) {
      if (cancelado?.()) {
        // Abortar ANTES de consultar mensagens: o turno ainda está rodando no
        // servidor, e ele que precisa ser cortado.
        await this.abortar(sessionID)
        throw new OpencodeError(`Turno abortado: ${cancelado.motivo || 'a task mudou de estado'}`, { status: 'cancelado' })
      }
      await new Promise((r) => setTimeout(r, intervaloMs))
      const mensagens = await this.request('GET', `/session/${sessionID}/message`, { timeoutMs: 30000 })
      const ultima = mensagens?.[mensagens.length - 1]
      if (!ultima || ultima.info?.role !== 'assistant') continue
      if (ultima.info?.time?.completed) return ultima
      log(`      ${ultima.info.id} ainda trabalhando (${ultima.parts?.length ?? 0} parts)`)
    }
    throw new OpencodeError(`Agente não terminou em ${Math.round(timeoutMs / 1000)}s`, { status: 'timeout' })
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
 * Onde está o executável do `opencode`.
 *
 * No Windows, o npm instala `opencode` como um shim: `opencode.cmd` e
 * `opencode.ps1` no diretório global, que na verdade chamam
 * `node_modules/opencode-ai/bin/opencode.exe`. `spawn('opencode', ...)` sem
 * `shell: true` procura o arquivo com nome exato e não acha o shim — falha com
 * ENOENT. E a saída fácil, `shell: true`, é o que o resto do orquestrador
 * evita de propósito: os argumentos viram string de shell.
 *
 * A saída é a mesma do `npm` em review.mjs: achar o executável real e spawnar
 * ele direto. `where` é o mecanismo do próprio Windows para isso.
 */
let alvoOpencode = null
function comandoOpencode() {
  if (alvoOpencode) return alvoOpencode
  if (process.platform !== 'win32') return 'opencode'

  try {
    const out = execFileSync('where', ['opencode'], { encoding: 'utf8', windowsHide: true })
    const candidatos = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    // O .exe é o que dá para executar sem shell; .cmd/.bat exigiriam shell.
    const exe = candidatos.find((c) => c.toLowerCase().endsWith('.exe'))
    if (exe && existsSync(exe)) {
      alvoOpencode = exe
      return alvoOpencode
    }
  } catch {}

  // Fallback: o layout padrão do npm global no Windows.
  const appdata = process.env.APPDATA
  if (appdata) {
    const guess = join(appdata, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    if (existsSync(guess)) {
      alvoOpencode = guess
      return alvoOpencode
    }
  }
  return 'opencode'
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
      comandoOpencode(),
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
  const parts = resposta?.parts || []
  const erros = []
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