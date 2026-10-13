/**
 * Estado das tarefas: fonte da verdade do orquestrador.
 *
 * A sessao do orquestrador e descartavel. Este arquivo e o que sobrevive a um
 * Ctrl+C, a um crash ou a um reinicio. Se uma informacao so existe na conversa,
 * ela esta perdida.
 *
 * Dois arquivos:
 *   .state/tasks.json  - snapshot atual (reescrito atomicamente)
 *   .state/events.jsonl - historico append-only (quem mudou o que, quando)
 *
 * O snapshot e reescrito inteiro na primeira alteracao e escrito em tmp+rename,
 * porque um arquivo truncado por queda de energia destroys mais estado do que
 * perder um evento.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const ESTADOS = [
  'pendente',
  'aguardando-dependencia',
  'pronta',
  'em-andamento',
  'aguardando-revisao',
  'bloqueada',
  'aguardando-integracao',
  'concluida',
  'falhou',
]

/** Estados em que a task ocupa um slot de concorrencia. */
export const ESTADOS_ATIVOS = ['em-andamento']

/** Estados a partir dos quais a task nao volta a ser despachada sozinha. */
export const ESTADOS_TERMINAIS = ['concluida', 'falhou']

/**
 * Transicoes permitidas. Um agente que responde "pronto" nao pode pular direto
 * para "concluida": e o orquestrador que decide, com base em revisao real.
 */
const TRANSICOES = {
  pendente: ['aguardando-dependencia', 'pronta', 'bloqueada', 'falhou'],
  'aguardando-dependencia': ['pronta', 'bloqueada', 'falhou'],
  pronta: ['em-andamento', 'bloqueada', 'falhou', 'aguardando-dependencia'],
  'em-andamento': ['aguardando-revisao', 'bloqueada', 'falhou', 'pronta'],
  'aguardando-revisao': ['aguardando-integracao', 'em-andamento', 'bloqueada', 'falhou'],
  // `aguardando-revisao` entra aqui por causa do `orq adopt`: quando o
  // orquestrador perde a conexão mas o agente termina e commita, a task volta
  // para revisão pelo caminho normal em vez de ficar presa em bloqueada.
  bloqueada: ['pronta', 'aguardando-dependencia', 'falhou', 'em-andamento', 'aguardando-revisao'],
  'aguardando-integracao': ['concluida', 'em-andamento', 'bloqueada', 'falhou'],
  concluida: [],
  falhou: ['pronta', 'em-andamento'],
}

export function transicaoValida(de, para) {
  if (de === para) return true
  return (TRANSICOES[de] || []).includes(para)
}

function agora() {
  return new Date().toISOString()
}

let contador = 0
/** ID sequencial legivel: T-001, T-002... So cresce. */
function proximoId(tasks) {
  let maior = 0
  for (const t of Object.values(tasks)) {
    const n = Number(String(t.id).replace(/\D/g, ''))
    if (Number.isFinite(n) && n > maior) maior = n
  }
  return 'T-' + String(maior + 1).padStart(3, '0')
}

/**
 * Normaliza o que o usuario mandou para a forma interna. Aceita string solta
 * (vira titulo) ou objeto; o que faltar ganha valor padrao explicito, porque
 * um campo ausente que o orquestrador inventar depois e pior que um vazio.
 */
export function normalizarTarefa(entrada, tasksExistentes = {}) {
  const agoraIso = agora()
  const base = {
    id: entrada.id || proximoId(tasksExistentes),
    titulo: '',
    descricao: '',
    origem: { tipo: 'manual', ref: null },
    componentes: [],
    criterios: [],
    dependsOn: [],
    prioridade: 3,
    risco: 'medio',
    arquivosAlvo: [],
    agente: null,
    sessionID: null,
    branch: null,
    worktree: null,
    baseRef: null,
    baseSha: null,
    arquivosAlterados: [],
    commits: [],
    testes: [],
    erros: [],
    bloqueios: [],
    decisoesPendentes: [],
    resultado: null,
    revisao: null,
    tentativa: 0,
    criadoEm: agoraIso,
    atualizadoEm: agoraIso,
  }

  const t = typeof entrada === 'string' ? { titulo: entrada } : { ...entrada }

  base.id = t.id || base.id
  base.titulo = String(t.titulo ?? t.descricao ?? '(sem título)').trim()
  base.descricao = String(t.descricao ?? t.titulo ?? '').trim()
  base.origem = { tipo: 'manual', ref: null, ...(t.origem || {}) }
  base.componentes = normalizarLista(t.componentes)
  base.criterios = normalizarLista(t.criterios)
  base.dependsOn = normalizarLista(t.dependsOn).map(String)
  base.arquivosAlvo = normalizarLista(t.arquivosAlvo)
  base.prioridade = clamp(Number(t.prioridade) || 3, 1, 5)
  base.risco = ['baixo', 'medio', 'alto'].includes(t.risco) ? t.risco : 'medio'
  base.descricao = base.descricao || base.titulo

  // Campos de execucao aceitam entrada (util para retomar/replay), mas nao
  // deixam o chamador inventar um resultado sem passar por revisao.
  for (const k of ['agente', 'sessionID', 'branch', 'worktree', 'baseRef', 'baseSha', 'estado']) {
    if (t[k] !== undefined) base[k] = t[k]
  }
  if (!ESTADOS.includes(base.estado)) base.estado = 'pendente'

  return base
}

function normalizarLista(v) {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v)
    .split(/[\n;,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

export class TaskStore {
  /**
   * @param {string} stateDir diretorio .state
   */
  constructor(stateDir) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'tasks.json')
    this.eventosFile = join(stateDir, 'events.jsonl')
    this.dados = { versao: 1, criadoEm: agora(), tasks: {} }
    mkdirSync(stateDir, { recursive: true })
    this.carregar()
  }

  carregar() {
    if (!existsSync(this.file)) {
      this.salvar()
      return
    }
    try {
      const bruto = readFileSync(this.file, 'utf8')
      const lido = JSON.parse(bruto)
      if (lido && typeof lido === 'object' && lido.tasks) this.dados = lido
    } catch (err) {
      // Um snapshot corrompido nao pode derrubar o orquestrador: o historico
      // append-only ainda vale e permite reconstrucao manual.
      const backup = this.file + '.corrompido-' + Date.now()
      try {
        renameSync(this.file, backup)
      } catch {}
      throw new Error(
        `tasks.json ilegível (${err.message}). Movido para ${backup}. ` +
          `O histórico continua em ${this.eventosFile}.`,
      )
    }
  }

  /** Escrita atomica: tmp + rename. Sem isso, queda no meio = estado corrompido. */
  salvar() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.dados, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  registrarEvento(taskId, tipo, dados = {}) {
    const linha = JSON.stringify({ ts: agora(), taskId, tipo, ...dados }) + '\n'
    appendFileSync(this.eventosFile, linha, 'utf8')
  }

  listar() {
    return Object.values(this.dados.tasks)
  }

  obter(id) {
    return this.dados.tasks[id] || null
  }

  criar(entrada) {
    const t = normalizarTarefa(entrada, this.dados.tasks)
    if (this.dados.tasks[t.id]) throw new Error(`Tarefa ${t.id} já existe.`)
    this.dados.tasks[t.id] = t
    this.salvar()
    this.registrarEvento(t.id, 'criada', { titulo: t.titulo, componentes: t.componentes })
    return t
  }

  criarVarias(entradas) {
    const criadas = []
    for (const e of entradas) criadas.push(this.criar(e))
    return criadas
  }

  /**
   * Atualiza campos e registra a mudanca no historico.
   * `patch` pode conter qualquer campo; campos de execucao sao livres porque
   * quem escreve e o proprio orquestrador.
   */
  atualizar(id, patch, evento = 'atualizada', dadosEvento = {}) {
    const t = this.obter(id)
    if (!t) throw new Error(`Tarefa ${id} não existe.`)
    Object.assign(t, patch, { atualizadoEm: agora() })
    this.salvar()
    this.registrarEvento(id, evento, dadosEvento)
    return t
  }

  /**
   * Muda de estado validando a transicao. Falhar alto aqui e o que impede um
   * task pular de "em andamento" direto para "concluida".
   */
  mudarEstado(id, para, patch = {}, motivo = null) {
    const t = this.obter(id)
    if (!t) throw new Error(`Tarefa ${id} não existe.`)
    const de = t.estado
    if (!transicaoValida(de, para)) {
      throw new Error(`Transição inválida: ${id} ${de} -> ${para}`)
    }
    if (para === 'em-andamento') {
      patch = { tentativa: (t.tentativa || 0) + 1, ...patch }
    }
    t.estado = para
    Object.assign(t, patch, { atualizadoEm: agora() })
    this.salvar()
    this.registrarEvento(id, 'estado', { de, para, motivo })
    return t
  }

  remover(id) {
    const t = this.obter(id)
    if (!t) return false
    delete this.dados.tasks[id]
    this.salvar()
    this.registrarEvento(id, 'removida', {})
    return true
  }

  /** Tarefas que nao estao em estado terminal. */
  ativas() {
    return this.listar().filter((t) => !ESTADOS_TERMINAIS.includes(t.estado))
  }

  porEstado(estado) {
    return this.listar().filter((t) => t.estado === estado)
  }

  /** Tarefas cuja lista de dependencias tem ids que nao existem no store. */
  dependenciasQuebradas() {
    const problemas = []
    for (const t of this.listar()) {
      for (const d of t.dependsOn) {
        if (!this.dados.tasks[d]) problemas.push({ taskId: t.id, dependeDe: d, motivo: 'inexistente' })
        else if (this.dados.tasks[d].dependsOn.includes(t.id))
          problemas.push({ taskId: t.id, dependeDe: d, motivo: 'ciclo' })
      }
    }
    return problemas
  }

  eventos() {
    if (!existsSync(this.eventosFile)) return []
    return readFileSync(this.eventosFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
}