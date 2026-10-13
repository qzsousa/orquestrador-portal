import { readFileSync } from 'node:fs'

const PORTAL = 'C:/Users/Pablo/Desktop/portal/src/utils/anexos.ts'
const BACKEND = 'C:/Users/Pablo/Desktop/chamados/shared/types/api.ts'

const portal = readFileSync(PORTAL, 'utf8')
const backend = readFileSync(BACKEND, 'utf8')

/** Pega a lista de extensões que o backend declara. */
function listaBackend(src) {
  const bloco = src.match(/const EXTENSOES_PADRAO = \[([\s\S]*?)\]/)[1]
  return [...bloco.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1])
}

/** Pega a lista que o portal declara. */
function listaPortal(src) {
  const bloco = src.match(/ANEXO_EXTENSOES: readonly string\[\] = \[([\s\S]*?)\]/)[1]
  return [...bloco.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1])
}

const b = listaBackend(backend)
const p = listaPortal(portal)

const soBackend = b.filter((e) => !p.includes(e))
const soPortal = p.filter((e) => !b.includes(e))
const foraDeOrdem = b.findIndex((e, i) => p[i] !== e)

console.log(`backend: ${b.length} extensoes`)
console.log(`portal:  ${p.length} extensoes`)
console.log(`so no backend (faltando no portal): ${soBackend.join(', ') || 'nenhuma'}`)
console.log(`so no portal (nao existe no backend): ${soPortal.join(', ') || 'nenhuma'}`)
console.log(`mesma ordem (mensagem de erro igual): ${foraDeOrdem === -1 ? 'sim' : 'NAO, diverge na posicao ' + foraDeOrdem}`)

// Limites
const maxB = backend.match(/ANEXO_MAX_BYTES = intDoEnv\('ANEXO_MAX_BYTES', (\d+) \* 1024 \* 1024\)/)
const maxP = portal.match(/TAMANHO_MAX_ANEXO = (\d+) \* 1024 \* 1024/)
console.log(`limite por arquivo — backend: ${maxB?.[1]}MB | portal: ${maxP?.[1]}MB | ${maxB?.[1] === maxP?.[1] ? 'iguais' : 'DIVERGEM'}`)

const qtdB = backend.match(/ANEXO_MAX_POR_PEDIDO = intDoEnv\('ANEXO_MAX_POR_PEDIDO', (\d+)\)/)
const qtdP = portal.match(/MAX_ANEXOS = (\d+)/)
console.log(`limite por envio   — backend: ${qtdB?.[1]} | portal: ${qtdP?.[1]} | ${qtdB?.[1] === qtdP?.[1] ? 'iguais' : 'DIVERGEM'}`)

function mapaMime(src) {
  const bloco = src.match(/MIME_POR_EXTENSAO[\s\S]*?\n\}/)[0]
  return new Map([...bloco.matchAll(/([a-z0-9]+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2]]))
}
const mimeB = mapaMime(backend)
const mimeP = mapaMime(portal)
console.log(`MIME por extensao — backend: ${mimeB.size} | portal: ${mimeP.size} | ${mimeB.size === mimeP.size ? 'contagem igual' : 'CONTAGEM DIVERGE'}`)

const semMimeBackend = b.filter((e) => !mimeB.has(e))
const semMimePortal = p.filter((e) => !mimeP.has(e))
console.log(`extensao sem MIME no backend: ${semMimeBackend.join(', ') || 'nenhuma'}`)
console.log(`extensao sem MIME no portal:  ${semMimePortal.join(', ') || 'nenhuma'}`)

const mimesDif = b.filter((e) => mimeB.has(e) && mimeP.has(e) && mimeB.get(e) !== mimeP.get(e))
console.log(`MIME divergente: ${mimesDif.join(', ') || 'nenhuma'}`)