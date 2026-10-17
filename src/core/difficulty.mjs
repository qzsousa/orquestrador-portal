/**
 * Dificuldade de uma task: um numero que explica para onde vai o modelo.
 *
 * Por que isso existe: o orquestrador usava UM modelo para tudo. Task de duas
 * linhas gastava o mesmo preco -- e o mesmo tempo -- que migracao de schema.
 * Aqui a dificuldade vira dado, e o runner usa esse dado para escolher o modelo
 * (ver `escolherModelo` em config.mjs) e para escrever no briefing o nivel
 * detectado, que e o que o agente usa para decidir o quanto precisa se
 * orientar antes de digitar.
 *
 * A heuristica e DELIBERADAMENTE burra e explicavel: soma pontos de sinais que
 * o orq ja tem em maos (risco do planner, numero de criterios, tamanho do
 * escopo, dependencias, componentes) e penaliza subtarefa, que e recorte de
 * algo maior. Nao usa LLM: um numero que muda o preco do workflow inteiro tem
 * que ser reproduzivel e auditavel em `orq plan`, nao uma segunda fonte de
 * opiniao. Se a heuristica errar, o custo e um modelo mais fraco numa task
 * dificil -- nunca um merge errado, porque o gate continua o mesmo.
 */

/**
 * Sinais de trabalho indivisível: contrato, dado, permissão, arquitetura.
 *
 * A regex de contrato exige um verbo de ação perto da palavra. Sem isso,
 * "NÃO invente contrato" — instrução que aparece justamente para o agente
 * NÃO mexer no contrato — contava como task que mexe no contrato. Erro de
 * leitura direta do enunciado, e o tipo de erro que faz a heurística
 * perder a credibilidade: ela precisa saber dizer "não achei nada" também.
 */
const PESADO = [
  {
    re: /(mudar|alterar|quebrar|expand|renomear|remover|adicionar|nova|novo).{0,24}contrato|contrato.{0,24}(muda|altera|quebra|novo)/i,
    pontos: 2,
    motivo: 'mexe em contrato',
  },
  { re: /prisma|schema|migrat|\bmigra\b/i, pontos: 2, motivo: 'schema/migracao de dado' },
  // Só as palavras que são unívocas do domínio de acesso. `token` e `permiss`
  // saíram de propósito: "limpeza de token" e "permissão para remover" são
  // frases comuns fora de autenticação, e Aqui elasacusavam falso positivo.
  { re: /autentica|\blogin\b|\bsenha\b|\bjwt\b|\bsso\b|credencial|\bjwt\b/i, pontos: 2, motivo: 'autenticacao' },
  { re: /refatora|reescrev|reestrutur|redesen|arquitetur/i, pontos: 2, motivo: 'refatoracao estrutural' },
  { re: /concorrent|transa(cao|ç)|rollback|idempot|deadlock/i, pontos: 2, motivo: 'regra de transacao/concorrencia' },
]

/** Sinais de trabalho largo, mas mecânico. Pesam menos que os de cima. */
const LEVE = [
  { re: /nova (tela|view|rota|aba)|criar (uma )?(tela|view|rota|aba)|do zero/i, pontos: 1, motivo: 'superficie de tela nova' },
  { re: /\bteste?s?\b|tdd|spec|cobertura|playwright/i, pontos: 1, motivo: 'testes' },
  { re: /tipagem|vue-tsc|typecheck|\blint\b|\btypes?\b/i, pontos: 1, motivo: 'tipagem/lint' },
  { re: /\bapi\b|endpoint|rota|route|payload|\bhttp\b/i, pontos: 1, motivo: 'superficie de API' },
  { re: /erro|falha|corrig|\bbug\b|regress|crash/i, pontos: 1, motivo: 'correcao de erro' },
  // Exige a INTENCAO, nao a palavra: "limpeza de codigo/senha/token preservada"
  // descreve o reset de um formulario, nao refatoracao. Aceitar "limpa" aqui
  // inflava qualquer task que mencione limpar um estado.
  { re: /refatora|simplific|dedup|organizar|limpar (c[oó]digo|duplica)|remover (c[oó]digo|duplica)/i, pontos: 1, motivo: 'refatoracao/limpeza' },
  { re: /acessib|teclado|leitor de tela|aria/i, pontos: 1, motivo: 'acessibilidade' },
  { re: /integr|orquestrador|\borq\b/i, pontos: 1, motivo: 'integracao' },
]

export const NIVEIS = ['facil', 'medio', 'dificil']

/**
 * Marcadores de negação que aparecem na janela ANTES de um termo.
 *
 * Task bem escrita protege o que não quer tocar: "NÃO invente contrato novo",
 * "sem alterar o contrato", "declara que falta endpoint em vez de mexer no
 * contrato". São frases que contêm o termo e o oposto do seu sentido — e sem
 * esta guarda, a task que mais bem』(des)escreve o limite é a que mais recebe
 * o modelo forte. Já é a segunda vez que a heurística erra aqui, então a
 * correção é explícita em vez de afinar o regex para a frase do momento.
 */
const NEGACAO = /(?:\bn[ãa]o\b|\bnem\b|\bsem\b|\bnunca\b|\bevit(?:a|ar|ando)\b|em vez de|n[ãa]o deve|apenas declara)/i
const JANELA_NEGACAO = 44

/**
 * Casa um termo, ignorando as ocorrências que estão sob negação.
 *
 * @param {RegExp} re deve ter a flag `g` para permitir varrer as ocorrências
 * @param {string} texto já em minúsculas
 */
function casaForaDeNegacao(re, texto) {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = global.exec(texto)) !== null) {
    const antes = texto.slice(Math.max(0, m.index - JANELA_NEGACAO), m.index)
    if (!NEGACAO.test(antes)) return true
    if (global.lastIndex === m.index) global.lastIndex++
  }
  return false
}

/**
 * Faixas. O corte entre `medio` e `dificil` fica em 5 porque é onde a
 * diferença aparece na prática: até 4, o agente erra por descuido (escopo,
 * tipo, texto) e a revisão pega; a partir de 5, ele erra por *estratégia* —
 * monta a coisa errada de um jeito que compila — e a revisão por critério
 * deixa passar.
 */
const CORTES = { facil: 2, medio: 4 }

/**
 * @param {object} task
 * @returns {{nivel: 'facil'|'medio'|'dificil', score: number, motivos: string[]}}
 */
export function calcularDificuldade(task = {}) {
  const criterios = task.criterios || []
  const arquivos = task.arquivosAlvo || []
  const deps = task.dependsOn || []
  const comps = task.componentes || []
  const texto = [task.titulo || '', task.descricao || '', ...criterios, ...arquivos].join(' ').toLowerCase()

  let score = 0
  const motivos = []

  const soma = (pontos, motivo) => {
    score += pontos
    motivos.push(`${motivo} (+${pontos})`)
  }

  // Risco ja vem do planner, que le o escopo declarado e a origem da task.
  // "baixo" pontua zero mas conta como EVIDENCIA de que o trabalho e pequeno —
  // sem isso, uma task explicitamente declarada simples cairia no ramo de
  // "sem sinal" e sairia media, que e o oposto do que quem declarou quis dizer.
  //
  // Peso 1, e nao 2: risco e consequencia se der errado, NAO volume de
  // trabalho. Sao eixos diferentes, e misturar os dois foi o que classificou
  // uma correcao de uma linha na tela de login como `dificil` — o planner
  // marca qualquer coisa com "senha"/"token" como risco alto, de proposito,
  // porque ali o estrago de um erro silencioso e grande. Isso nao significa
  // que a task demora mais. Agora o risco pesa pouco e o escopo pesa.
  if (task.risco === 'alto') soma(1, 'risco alto')
  else if (task.risco === 'medio') soma(0, 'risco medio')
  else if (task.risco === 'baixo') soma(0, 'risco baixo')

  // Escopo: quantos arquivos a task admite tocar. E o sinal mais direto de
  // quanto contexto o agente precisa carregar antes de editar.
  //
  // O degrau em 2 arquivos e o que separa as tasks na pratica. Um arquivo e
  // "edita e repara". Dois ou tres e "eles precisam concordar entre si" — no
  // caso do portal, rota, menu e view: os tres divergem com sucesso, e o
  // gate (que e so build) nao acusa. Esse e o salto que produz o erro
  // estrategico, e nao o volume de linhas.
  if (arquivos.length >= 8) soma(2, `escopo largo (${arquivos.length} arquivos)`)
  else if (arquivos.length >= 2) soma(1, `escopo em ${arquivos.length} arquivos`)

  // Criterios de aceitacao entram so na faixa alta, e de proposito: criterio e
  // lista de conferencia, nao tamanho do trabalho. Uma correcao de uma linha
  // costuma vir com seis criterios — "build passa", "comportamento antigo
  // preservado", "relatorio honesto" — e nenhum deles e codigo a escrever.
  // Doze criterios ja e sinal de que a caixa e maior do que o titulo conta.
  if (criterios.length >= 12) soma(2, `${criterios.length} criterios de aceitacao`)

  // Dependencia nao torna a task dificil de escrever, mas torna errada com
  // mais probabilidade: e a task que precisa da outra ja integrada.
  if (deps.length) soma(1, `depende de ${deps.join(', ')}`)

  // Atravessar componente e o que transforma "editar" em "mudar arquitetura":
  // o outro lado do contrato precisa mudar junto. Pesa acima de "muitos
  // arquivos" de proposito — editar 8 arquivos dentro de um repo e um trabalho
  // longo mas local; editar os dois lados de um contrato e o trabalho que
  // volta para revisão porque o consumidor ficou para trás.
  if (comps.length >= 2) soma(3, `atravessa ${comps.length} componentes`)

  for (const s of PESADO) if (casaForaDeNegacao(s.re, texto)) soma(s.pontos, s.motivo)
  for (const s of LEVE) if (casaForaDeNegacao(s.re, texto)) soma(s.pontos, s.motivo)

  // Sem sinal nenhum? Nao e facil por falta de evidencia, e desconhecida. O
  // piso e `medio` -- com a configuracao padrao isso manda pro mesmo modelo do
  // global, entao nao custa nada; com escalate configurado, custa o preco do
  // modelo forte numa task que talvez fosse trivial. Melhor.
  if (motivos.length === 0) return { nivel: 'medio', score: 0, motivos: ['sem sinal de escopo: tratado como medio'] }

  // Subtrair so depois de somar: uma subtarefa com "contrato" no texto e uma
  // subtarefa de contrato -- recorte, nao arquitetura.
  if (task.pai) {
    score -= 1
    motivos.push('subtarefa: escopo recortado (-1)')
  }

  if (score <= CORTES.facil) return { nivel: 'facil', score, motivos }
  if (score <= CORTES.medio) return { nivel: 'medio', score, motivos }
  return { nivel: 'dificil', score, motivos }
}

/** Uma linha para o `orq plan` e para o log do runner. */
export function descreverDificuldade(d) {
  if (!d) return 'desconhecida'
  return `${d.nivel} (${d.score}): ${d.motivos.join(', ')}`
}