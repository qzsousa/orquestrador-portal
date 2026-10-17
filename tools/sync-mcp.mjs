/**
 * Escreve os MCPs do `orq.config.mjs` em ~/.config/opencode/opencode.jsonc.
 *
 * Por que este arquivo e nao o runner: MCP e configuracao da MAQUINA, nao da
 * task. O `opencode serve` e um so e le o config do usuario, entao e la que os
 * servidores precisam estar para o agente os ver. E o orq mantem esse arquivo
 * sob controle -- com tres garantias que o "so sobrescreve" nao tem:
 *
 *   1. O que o orq NAO gerencia, ele nao toca. Chaves do config global
 *      (`model`, `theme`, `permission`, outros MCPs) sao preservadas.
 *   2. Servidor que o orq desabilitou so e removido se o orq mesmo o escreveu
 *      antes. Um MCP instalado a mao sobrevive a `enabled: false`.
 *   3. O resultado e validado contra o schema do OpenCode antes de escrever.
 *
 * O ponto 3 nao e exagero: a primeira versao escrevia `type: "stdio"` com
 * `command` string e um marcador `_orq` dentro de `mcp`. O OpenCode le o
 * arquivo inteiro com validacao estrita (`additionalProperties: false`), entao
 * isso derrubou o servidor em TODOS os diretorios -- o orq parou de funcionar
 * e, junto, o OpenCode do usuario. Descobrir o formato lendo o schema e uma
 * coisa; continuar escrevendo errado depois de saber, nao.
 *
 * O rastreio de "o que o orq escreveu" fica num arquivo ao lado
 * (`opencode.orq.json`), porque nao ha lugar para ele dentro do config: a raiz
 * tambem e `additionalProperties: false`.
 *
 *   node tools/sync-mcp.mjs           # escreve
 *   node tools/sync-mcp.mjs --dry-run # mostra o que faria
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { carregarConfig, mcpAtivos } from '../src/core/config.mjs'

const dryRun = process.argv.includes('--dry-run')

/** Caminho do config global do OpenCode, por plataforma. */
function caminhoConfig() {
  const home = process.env.USERPROFILE || process.env.HOME
  if (!home) throw new Error('Nao encontrei o home do usuario (USERPROFILE/HOME vazio).')
  return join(home, '.config', 'opencode', 'opencode.jsonc')
}

/**
 * Le JSON com comentarios (JSONC).
 *
 * O OpenCode aceita `.jsonc` e a pessoa naturalmente escreve comentario
 * dentro. `JSON.parse` falha nesses arquivos, e o caminho obvio para arquivo
 * desconhecido -- sobrescrever -- e o que apaga configuracao alheia. Entao:
 * tenta parsear cru; se falhar, tira comentario respeitando string; se ainda
 * falhar, PARA e diz o motivo.
 */
function lerJsonc(caminho) {
  if (!existsSync(caminho)) return {}
  const bruto = readFileSync(caminho, 'utf8')
  if (!bruto.trim()) return {}
  try {
    return JSON.parse(bruto)
  } catch {}
  const semComentario = bruto
    .replace(/\\"/g, '\u0000') // protege aspas escapadas antes de mexer nas strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => s.replace(/\u0000/g, '\\"')) // strings intactas
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\u0000/g, '\\"')
    .replace(/,(\s*[}\]])/g, '$1') // virgula sobrando antes de fecha
  try {
    return JSON.parse(semComentario)
  } catch (err) {
    throw new Error(
      `${caminho} nao e JSON valido nem JSONC com comentario: ${err.message}\n` +
        'Nao vou sobrescrever um arquivo que nao consigo ler. Corrija o JSON ou apague o arquivo e rode de novo.',
    )
  }
}

/**
 * Valida o trecho de `mcp` contra o schema do OpenCode.
 *
 * Sem fetch do schema de propósito: ele é remoto e pode cair, e um sync que
 * depende da rede para decidir se pode escrever é um sync que já falhou uma
 * vez. As regras abaixo são as do `https://opencode.ai/config.json` lidas na
 * raiz do config — e a validação mais honesta é o próprio servidor subir, o
 * que o `orq run` faz logo em seguida.
 */
function validarMcp(config) {
  const erros = []
  const raiz = config || {}
  if (raiz.mcp === undefined) return erros
  if (typeof raiz.mcp !== 'object' || Array.isArray(raiz.mcp)) {
    erros.push('mcp precisa ser um objeto')
    return erros
  }
  for (const chave of Object.keys(raiz.mcp)) {
    if (chave !== 'servers' && chave !== 'timeout') {
      erros.push(
        `mcp.${chave} nao existe no schema. A raiz do config e additionalProperties:false, ` +
          'entao chave de bookkeeping tem que ficar fora do arquivo.',
      )
    }
  }
  for (const [nome, def] of Object.entries(raiz.mcp.servers || {})) {
    const em = (campo) => `mcp.servers.${nome}.${campo}`
    if (!def || typeof def !== 'object') {
      erros.push(em('(servidor)') + ' precisa ser um objeto')
      continue
    }
    if (def.type !== 'local' && def.type !== 'remote') {
      erros.push(em('type') + ` precisa ser "local" ou "remote" (recebi ${JSON.stringify(def.type)})`)
    }
    if (def.type === 'local' && !Array.isArray(def.command)) {
      erros.push(em('command') + ' precisa ser um array de strings: [executavel, ...argumentos]')
    } else if (def.type === 'local' && def.command.some((c) => typeof c !== 'string')) {
      erros.push(em('command') + ' so aceita string')
    }
    if (def.type === 'remote' && typeof def.url !== 'string') {
      erros.push(em('url') + ' e obrigatorio quando type e "remote"')
    }
    if ('enabled' in def) erros.push(em('enabled') + ' nao existe no config; o flag e "disabled"')
    if ('args' in def) erros.push(em('args') + ' nao existe no config; os argumentos vao em "command"')
    if ('env' in def) erros.push(em('env') + ' nao existe no config; o campo e "environment"')
    const conhecidos = new Set(['type', 'command', 'cwd', 'environment', 'disabled', 'codemode', 'timeout', 'url', 'headers', 'oauth'])
    for (const k of Object.keys(def)) {
      if (!conhecidos.has(k)) erros.push(em(k) + ' nao existe no schema do OpenCode')
    }
  }
  return erros
}

/**
 * Remove dos SERVIDORES as entradas que a VERSÃO ANTERIOR deste script
 * escrevia.
 *
 * Sem isso, o orq fica preso: o arquivo invalido impede o servidor de subir, o
 * servidor de cima impede o sync de rodar, e o sync de la era a causa. Quem
 *_visconde_ com defeito e precisa de conserto nao pode ser o mesmo codigo que
 * tem o defeito.
 *
 * So remove quando as duas condicoes batem: o nome esta no registro do orq
 * (`cfg.mcp.servers`) E o corpo tem a assinatura exata da versao antiga
 * (`type: "stdio"` com `command` string, que o schema nunca aceitou). Um MCP
 * do usuario com nome parecido, ou um MCP do orq em formato valido, ficam
 * intactos -- apagar configuracao alheia nao e efeito colateral aceitavel.
 */
function sanear(servers, nomesDoOrq) {
  const saida = { ...(servers || {}) }
  const removidos = []
  for (const [nome, def] of Object.entries(saida)) {
    const nossoEFromatadoAntigo =
      nomesDoOrq.has(nome) &&
      def &&
      typeof def === 'object' &&
      (def.type === 'stdio' || (typeof def.command === 'string' && def.args !== undefined))
    if (nossoEFromatadoAntigo) {
      delete saida[nome]
      removidos.push(nome)
    }
  }
  return { servers: saida, removidos }
}

const cfg = await carregarConfig()
const destino = caminhoConfig()
const lateral = destino + '.orq.json'

const atual = lerJsonc(destino)
const nomesDoOrq = new Set(Object.keys(cfg?.mcp?.servers || {}))
const { servers: serversExistentes, removidos: saneados } = sanear(atual?.mcp?.servers, nomesDoOrq)
const antes = erros => {
  if (erros.length) {
    console.error('\n✗ O config que seria escrito viola o schema do OpenCode:')
    for (const e of erros) console.error('  - ' + e)
    console.error('\nNada foi escrito. O servidor do OpenCode cai inteiro quando o config tem chave invalida,')
    console.error('entao o sync se recusa a escrever em vez de deixar o OpenCode quebrado.')
    process.exit(1)
  }
}

const gerenciadosAntes = existsSync(lateral)
  ? (JSON.parse(readFileSync(lateral, 'utf8')).gerenciados || [])
  : []
const gerenciados = new Set(mcpAtivos(cfg).map((s) => s.nome))
const removidos = gerenciadosAntes.filter((n) => !gerenciados.has(n))

// `mcpAtivos` ja devolve no shape do OpenCode, com `enabled` traduzido para
// `disabled` e `command`/`args` juntados num array.
const servers = { ...serversExistentes }
for (const nome of removidos) delete servers[nome]
for (const { nome, def } of mcpAtivos(cfg)) servers[nome] = def

const saida = { ...atual, $schema: atual.$schema || 'https://opencode.ai/config.json' }
// A RAIZ do config e `additionalProperties: false`: chave que o OpenCode nao
// conhece derruba o servidor em todo diretorio. Por isso nada de marcador de
// bookkeeping aqui dentro — ele vive no arquivo ao lado.
delete saida.mcp
if (Object.keys(servers).length) saida.mcp = { servers }

antes(validarMcp(saida))

console.log(`config: ${destino}`)
for (const nome of saneados) console.log(`  limpa    ${nome} (formato invalido que o orq antigo escreveu)`)
for (const { nome, def } of mcpAtivos(cfg)) {
  const alvo = def.command.filter((c) => !String(c).startsWith('-') && !String(c).includes('@')).join(' ')
  console.log(`  ${gerenciadosAntes.includes(nome) ? 'atualiza' : 'inclui  '} ${nome}${alvo ? ` -> escopo: ${alvo}` : ''}`)
}
for (const nome of removidos) console.log(`  remove   ${nome} (desligado no orq.config.mjs)`)

const mudou =
  saneados.length > 0 ||
  JSON.stringify(atual, null, 2) !== JSON.stringify(saida, null, 2)
if (!mudou && gerenciadosAntes.length === gerenciados.size) {
  console.log('\nnada a fazer: o config global ja esta sincronizado')
  process.exit(0)
}
if (dryRun) {
  console.log('\n--dry-run: nada foi escrito')
  process.exit(0)
}

if (existsSync(destino)) {
  const bak = `${destino}.bak`
  copyFileSync(destino, bak)
  console.log(`\nbackup: ${bak}`)
}
mkdirSync(dirname(destino), { recursive: true })
writeFileSync(destino, JSON.stringify(saida, null, 2) + '\n', 'utf8')
writeFileSync(lateral, JSON.stringify({ gerenciados: [...gerenciados].sort() }, null, 2) + '\n', 'utf8')
console.log(`\nescrito: ${destino}`)
console.log(`rastreio: ${lateral}`)
console.log('O servidor do OpenCode le o config na proxima inicializacao: reinicie o `opencode serve` para valer.')
