/**
 * Import opcional do Trello.
 *
 * Princípio: credencial NUNCA entra no código nem no repo. Este módulo só lê
 * `TRELLO_API_KEY` e `TRELLO_TOKEN` do ambiente. Sem elas, `importar()` falha
 * com mensagem clara e o resto do orquestrador continua funcionando com tarefas
 * manuais — a ausência de credencial não pode impedir a construção do sistema.
 *
 * Como o token é enviado em query string (exigência da API do Trello), ele
 * nunca aparece em log: `ocultar()` é aplicado em toda mensagem de erro.
 */

const BASE = 'https://api.trello.com/1'

export function credenciais() {
  const key = process.env.TRELLO_API_KEY
  const token = process.env.TRELLO_TOKEN
  const faltando = []
  if (!key) faltando.push('TRELLO_API_KEY')
  if (!token) faltando.push('TRELLO_TOKEN')
  if (faltando.length) {
    throw new Error(
      `Trello não configurado. Faltam: ${faltando.join(', ')}.\n` +
        `Defina no ambiente do PowerShell antes de usar:\n` +
        `  $env:TRELLO_API_KEY="..."\n  $env:TRELLO_TOKEN="..."\n` +
        `Para torná-lo persistente na sua máquina (fora do repo):\n` +
        `  setx TRELLO_API_KEY "..."   /  setx TRELLO_TOKEN "..."\n` +
        `As tasks também podem ser informadas manualmente: orq add "texto".`,
    )
  }
  return { key, token }
}

/** Remove credencial de qualquer texto antes de logar ou exibir. */
export function ocultar(s) {
  return String(s)
    .replace(/key=[^&\s]+/gi, 'key=***')
    .replace(/token=[^&\s]+/gi, 'token=***')
}

async function chamar(caminho, params = {}) {
  const { key, token } = credenciais()
  const url = new URL(BASE + caminho)
  url.searchParams.set('key', key)
  url.searchParams.set('token', token)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    const corpo = await res.text().catch(() => '')
    throw new Error(`Trello ${caminho} -> HTTP ${res.status}: ${ocultar(corpo).slice(0, 300)}`)
  }
  return res.json()
}

/**
 * Lê cards de um board e converte em tarefas.
 *
 * O checklist do card vira subtarefa (ver `subtarefasDeChecklist`): card de card
 * com 4 itens é 4 tarefas, não uma. Os labels viram componente quando batem com
 * o registro de componentes, e a dependência entre cards é lida da descrição
 * quando ela contém "T-002" / "depende de T-002".
 */
export async function importar({ boardId, listas = null, componentesValidos = [] }) {
  if (!boardId) {
    throw new Error('Informe o board: orq trello-sync --board <id>. Ou defina TRELLO_BOARD_ID no ambiente.')
  }

  const [board, listasBoard] = await Promise.all([chamar(`/boards/${boardId}`), chamar(`/boards/${boardId}/lists`)])

  const filtro = new Set(listas || cfgListas())
  const listasAlvo = filtro.size ? listasBoard.filter((l) => filtro.has(l.name)) : listasBoard

  const tarefas = []
  for (const lista of listasAlvo) {
    const cards = await chamar(`/lists/${lista.id}/cards`, { fields: 'name,desc,idList,labels,due,closed' })

    for (const card of cards) {
      if (card.closed) continue

      // Checklist: itens viram subtarefas.
      let checklists = []
      try {
        checklists = await chamar(`/cards/${card.id}/checklists`)
      } catch {
        /* board sem permissão de checklist não invalida o resto */
      }

      const componentes = (card.labels || [])
        .map((l) => l.name.toLowerCase().trim())
        .filter((n) => componentesValidos.includes(n))

      const idBase = `TR-${card.id.slice(0, 6).toUpperCase()}`
      const dependencias = extrairDependencias(card.desc || '')

      tarefas.push({
        idExterno: card.id,
        titulo: card.name,
        descricao: limparHtml(card.desc || ''),
        origem: { tipo: 'trello', ref: card.id, lista: lista.name, url: `${card.url || ''}` },
        componentes,
        dependsOn: dependencias,
        prioridade: prioridadeDoCard(card.due),
        risco: undefined,
        checklists: checklists.flatMap((c) => c.checkItems || []).map((i) => ({ texto: i.name, feito: i.state === 'complete' })),
        // Subtask IDs são gerados pelo planner a partir do idBase.
      })
    }
  }

  return { board: { id: board.id, nome: board.name }, listas: listasAlvo.map((l) => l.name), tarefas }
}

function cfgListas() {
  const v = process.env.TRELLO_LISTAS
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
}

/** "depende de T-002" / "bloqueado por T-002" no corpo do card. */
function extrairDependencias(desc) {
  const out = new Set()
  const re = /(?:depende de|dependencia de|bloquead[oa] por|aguarda)\s*:?\s*([A-Z]{1,3}-?\d{1,4}[A-Z0-9.\-]*)/gi
  let m
  while ((m = re.exec(desc || ''))) out.add(m[1].toUpperCase())
  return [...out]
}

/** Trello não tem prioridade; a data de entrega vira proxy dela. */
function prioridadeDoCard(due) {
  if (!due) return 3
  const dias = (new Date(due).getTime() - Date.now()) / 86400000
  if (dias <= 2) return 5
  if (dias <= 7) return 4
  if (dias <= 30) return 2
  return 1
}

function limparHtml(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}