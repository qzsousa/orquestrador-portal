/**
 * Testes do roteamento: dificuldade, escolha de modelo, MCPs e skills.
 *
 * A dificuldade decide o modelo, então ela decide quanto custa rodar a fila.
 * Testar os tres juntos e proposital: um `escolherModelo` correto com uma
 * dificuldade errada continua sendo o preco errado.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { calcularDificuldade, descreverDificuldade } from '../src/core/difficulty.mjs'
import { escolherModelo, tabelaDeModelos, avisosDeModelo, mcpAtivos } from '../src/core/config.mjs'
import { skillsSugeridas, modeloDe } from '../src/core/runner.mjs'

describe('modeloDe — a traducao que o POST /session exige', () => {
  // Este describe existe por causa de um bug real: `modeloDe` estava declarada
  // dentro de `reanexarTask`, por uma chave de fechamento faltando em
  // `reanexarTask`. O arquivo continuava sintaticamente valido, então
  // `node --check` passava, `npm test` passava, e o primeiro sintoma era
  // `ReferenceError: modeloDe is not defined` no meio de uma task — depois de
  // worktree criado, branch criada e ambiente preparado. Importar por nome
  // pega esse tipo de erro na hora: se a função voltar a ficar aninhada, o
  // import falha em vez de a task falhar.
  test('converte "provider/modelo" no objeto que a API aceita', () => {
    assert.deepEqual(modeloDe('opencode/space-bunny-free'), {
      providerID: 'opencode',
      id: 'space-bunny-free',
    })
  })

  test('objeto passa direto, sem reembrulhar', () => {
    const obj = { providerID: 'opencode', id: 'x' }
    assert.equal(modeloDe(obj), obj)
  })

  test('vazio e null viram undefined, não string solta', () => {
    // `undefined` é o que o POST aceita como "sem modelo"; uma string vazia
    // seria rejeitada com 400 e derrubaria a task por config, não por código.
    assert.equal(modeloDe(''), undefined)
    assert.equal(modeloDe(null), undefined)
    assert.equal(modeloDe(undefined), undefined)
  })

  test('string sem barra é ignorada em vez de gerar provider vazio', () => {
    assert.equal(modeloDe('space-bunny-free'), undefined)
    assert.equal(modeloDe('/sem-provider'), undefined)
  })
})

describe('dificuldade — o que sobe e o que desce', () => {
  test('escopo largo com risco alto é difícil', () => {
    const d = calcularDificuldade({
      titulo: 'migrar schema prisma de chamado',
      risco: 'alto',
      arquivosAlvo: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      componentes: ['chamados'],
    })
    assert.equal(d.nivel, 'dificil')
    assert.ok(d.motivos.length > 0, 'explica o porquê, não só o número')
  })

  test('task pequena com um critério é fácil', () => {
    const d = calcularDificuldade({ titulo: 'ajustar cor do botão', risco: 'baixo', criterios: ['fica azul'] })
    assert.equal(d.nivel, 'facil')
  })

  test('sem sinal nenhum é médio, nunca fácil', () => {
    // O ponto do teste: task sem escopo declarado não é "fácil por ausência de
    // evidência". Tratar como fácil mandaria task real para o modelo fraco.
    const d = calcularDificuldade({ titulo: 'ajustar texto' })
    assert.equal(d.nivel, 'medio')
    assert.match(d.motivos.join(' '), /sem sinal/)
  })

  test('subtarefa desconta em relação à task-mãe', () => {
    // Uma task com 12+ critérios tem score positivo; a mesma task como
    // subtarefa precisa ficar abaixo, senão o desconto não existe.
    const base = { titulo: 'ajustar campo', risco: 'medio', criterios: Array(12).fill('critério') }
    const mae = calcularDificuldade(base)
    const sub = calcularDificuldade({ ...base, pai: 'T-001' })
    assert.ok(mae.score > 0, 'a task-mãe tem de ter score para o desconto significar algo')
    assert.ok(sub.score < mae.score, 'subtarefa é recorte, não trabalho novo')
    assert.ok(sub.motivos.some((m) => m.includes('subtarefa')))
  })

  test('atravessar componente pesa mais que tamanho de arquivo', () => {
    const soArquivos = calcularDificuldade({ titulo: 'ajustar', risco: 'baixo', arquivosAlvo: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })
    const doisComps = calcularDificuldade({ titulo: 'ajustar', risco: 'baixo', componentes: ['chamados', 'portal'] })
    assert.ok(doisComps.score > soArquivos.score, 'mudar arquitetura custa mais que editar muito')
  })

  test('descreverDifficulty é uma linha legível', () => {
    const d = calcularDificuldade({ titulo: 'x', risco: 'baixo' })
    assert.match(descreverDificuldade(d), /^(facil|medio|dificil) \(\d+\): /)
  })
})

describe('dificuldade — o que NÃO pode ser confundido', () => {
  // Estes casos existem porque a heurística errou com eles na primeira versão.
  // Todos são frases que aparecem em task real, não invenção de teste.

  test('"não invente contrato" não vira "mexe em contrato"', () => {
    const d = calcularDificuldade({
      titulo: 'nova tela de agenda',
      risco: 'baixo',
      descricao: 'persistir em localStorage e declarar que falta endpoint, em vez de inventar contrato novo',
      componentes: ['portal'],
    })
    assert.ok(!d.motivos.some((m) => m.includes('contrato')), 'negação não é ação')
  })

  test('"limpeza de token" não vira refatoração nem autenticação', () => {
    const d = calcularDificuldade({
      titulo: 'corrigir botão do login',
      risco: 'baixo',
      criterios: ['a limpeza de código/senha/token continua igual'],
      componentes: ['portal'],
    })
    assert.ok(!d.motivos.some((m) => m.includes('refatoracao')), 'limpar um estado não é refatorar')
  })

  test('risco alto sozinho não vira difícil', () => {
    // O planner marca qualquer coisa com "senha" como risco alto, de propósito.
    // Se risco alto empurrasse para difícil, toda task de autenticação seria
    // difícil e o modelo forte nunca seria reservado para o que é difícil.
    const d = calcularDificuldade({ titulo: 'ajustar avatar', risco: 'alto', componentes: ['portal'] })
    assert.notEqual(d.nivel, 'dificil')
  })

  test('critério de conferência não conta como volume', () => {
    const seis = calcularDificuldade({ titulo: 'ajustar', risco: 'baixo', criterios: Array(6).fill('x') })
    assert.ok(seis.motivos.every((m) => !m.includes('criterios')), '6 critérios não são 6 tarefas')
  })
})

describe('escolherModelo — precedência', () => {
  const base = {
    componentes: { portal: {}, chamados: {} },
    agentes: { workerModel: 'opencode/worker-global' },
    modelo: 'opencode/global',
  }

  test('sem models configurados, cai no componente e depois no global', () => {
    assert.equal(escolherModelo(base, 'portal'), 'opencode/global')
    assert.equal(escolherModelo({ ...base, componentes: { portal: { modelo: 'opencode/so-portal' } } }, 'portal'), 'opencode/so-portal')
  })

  test('byDifficulty vence o global', () => {
    const cfg = { ...base, models: { byDifficulty: { dificil: 'opencode/forte' } } }
    assert.equal(escolherModelo(cfg, 'portal', { nivel: 'dificil' }), 'opencode/forte')
    assert.equal(escolherModelo(cfg, 'portal', { nivel: 'facil' }), 'opencode/global', 'nível sem entrada não muda nada')
  })

  test('byCompDifficulty vence byDifficulty', () => {
    const cfg = {
      ...base,
      models: {
        byDifficulty: { dificil: 'opencode/forte' },
        byCompDifficulty: { chamados: { dificil: 'opencode/forte-no-chamados' } },
      },
    }
    assert.equal(escolherModelo(cfg, 'chamados', { nivel: 'dificil' }), 'opencode/forte-no-chamados')
    assert.equal(escolherModelo(cfg, 'portal', { nivel: 'dificil' }), 'opencode/forte')
  })

  test('preferDifficulty:false devolve a prioridade ao componente', () => {
    const cfg = {
      ...base,
      componentes: { portal: { modelo: 'opencode/so-portal' }, chamados: {} },
      models: { preferDifficulty: false, byDifficulty: { dificil: 'opencode/forte' } },
    }
    assert.equal(escolherModelo(cfg, 'portal', { nivel: 'dificil' }), 'opencode/so-portal')
  })

  test('nada configurado devolve null = default do servidor', () => {
    assert.equal(escolherModelo({ componentes: { portal: {} }, modelos: null }, 'portal', { nivel: 'dificil' }), null)
  })

  test('tabelaDeModelos cobre todos os níveis de todos os componentes', () => {
    const tabela = tabelaDeModelos(base)
    assert.equal(tabela.length, 2)
    for (const linha of tabela) {
      assert.deepEqual(Object.keys(linha.porNivel), ['facil', 'medio', 'dificil'])
    }
  })

test('avisosDeModelo só reclama do que está fora da faixa gratuita conhecida', () => {
    const cfg = {
      ...base,
      componentes: { portal: {}, chamados: {} },
      modelo: null,
      models: {
        listaDeModelosGratis: ['opencode/space-bunny-free', 'opencode/grok-code-fast-1'],
        byDifficulty: { facil: 'opencode/space-bunny-free', dificil: 'opencode/modelo-pago' },
      },
    }
    const avisos = avisosDeModelo(cfg)
    // Dois: o `modelo-pago` do nível difícil e o `worker-global` herdado de
    // `base`, que também não está na lista. O dedupe é por modelo, então o
    // mesmo nome em dois componentes não vira dois avisos.
    assert.equal(avisos.length, 2)
    assert.ok(avisos.some((a) => a.includes('modelo-pago')))
    assert.ok(avisos.some((a) => a.includes('worker-global')))
    assert.ok(!avisos.some((a) => a.includes('space-bunny-free')), 'modelo conhecido não vira aviso')
  })

  // O caso que vale mais: com o catálogo do servidor na mão, a lista escrita à
  // mão não decide mais nada. Foi assim que três modelos inventados passaram
  // pelo aviso e deixaram duas tasks em-andamento para sempre.
  test('catálogo do servidor tem precedência sobre o snapshot do config', () => {
    const cfg = {
      ...base,
      componentes: { portal: {} },
      agentes: {},
      modelo: null,
      models: {
        listaDeModelosGratis: ['opencode/inventado-por-mim'],
        byDifficulty: { facil: 'opencode/inventado-por-mim' },
      },
    }
    const catalogo = ['opencode/existe-de-verdade']
    const avisos = avisosDeModelo(cfg, catalogo)
    assert.equal(avisos.length, 1, 'o snapshot dizia que estava tudo bem; o catálogo não')
    assert.match(avisos[0], /catalogo do servidor/)
  })

  test('catálogo vazio não gera falso positivo contra o snapshot', () => {
    const cfg = {
      ...base,
      componentes: { portal: {} },
      agentes: {},
      modelo: null,
      models: {
        listaDeModelosGratis: ['opencode/space-bunny-free'],
        byDifficulty: { facil: 'opencode/space-bunny-free' },
      },
    }
    assert.deepEqual(avisosDeModelo(cfg, []), [], 'servidor fora do air não vira acusação')
  })
})

describe('mcpAtivos — o que o sync-mcp vai escrever', () => {
  const cfg = (servers, extra = {}) => ({
    worktreesDir: 'C:/wt',
    raiz: 'C:/orq',
    mcp: { servers, ...extra },
  })

  test('só devolve o que está habilitado', () => {
    const ativos = mcpAtivos(
      cfg({
        ligado: { type: 'local', command: ['x'], enabled: true },
        desligado: { type: 'local', command: ['y'], enabled: false },
        semComando: { type: 'remote', url: 'http://x' },
      }),
    )
    assert.deepEqual(ativos.map((s) => s.nome), ['ligado'])
  })

  test('mcp.enabled = false desliga tudo', () => {
    assert.equal(mcpAtivos(cfg({ ligado: { command: ['x'] } }, { enabled: false })).length, 0)
  })

  test('token ${worktreesDir} é resolvido', () => {
    const [s] = mcpAtivos(cfg({ fs: { command: ['npx', '-y', 'srv', '${worktreesDir}'] } }))
    assert.deepEqual(s.def.command, ['npx', '-y', 'srv', 'C:/wt'])
  })

  test('token desconhecido fica visível em vez de virar caminho vazio', () => {
    const [s] = mcpAtivos(cfg({ x: { command: ['${naoExiste}'] } }))
    assert.equal(s.def.command[0], '${naoExiste}')
  })

  // O formato de saída é o ponto que já quebrou o servidor uma vez: o
  // OpenCode valida o config inteiro e derruba se uma chave estiver errada.
  test('saída usa o shape do OpenCode: type local, command array, disabled', () => {
    const [s] = mcpAtivos(cfg({ fs: { command: ['npx', '-y', 'srv'], enabled: true } }))
    assert.equal(s.def.type, 'local')
    assert.ok(Array.isArray(s.def.command))
    assert.equal(s.def.disabled, false)
    assert.ok(!('enabled' in s.def), 'enabled não existe no config do OpenCode')
  })

  test('args e command string da entrada são fundidos num array só', () => {
    const [s] = mcpAtivos(cfg({ fs: { command: 'npx', args: ['-y', 'srv'], enabled: true } }))
    assert.deepEqual(s.def.command, ['npx', '-y', 'srv'])
    assert.ok(!('args' in s.def))
  })

  test('env vira environment', () => {
    const [s] = mcpAtivos(cfg({ fs: { command: ['x'], env: { TOKEN: '1' } } }))
    assert.deepEqual(s.def.environment, { TOKEN: '1' })
    assert.ok(!('env' in s.def))
  })
})

describe('skillsSugeridas — o que entra no briefing', () => {
  test('componente define a base', () => {
    const s = skillsSugeridas({ titulo: 'ajustar algo' }, ['portal'])
    assert.ok(s.includes('frontend-design'))
    assert.ok(s.includes('coding-standards'), 'piso para qualquer repo')
  })

  test('assunto da task acrescenta skill específica', () => {
    const s = skillsSugeridas({ titulo: 'migrar schema prisma' }, ['chamados'])
    assert.ok(s.includes('postgres-patterns'))
    assert.ok(s.includes('backend-patterns'))
  })

  test('bug puxa verification-loop, contrato puxa eval-harness', () => {
    assert.ok(skillsSugeridas({ titulo: 'corrigir erro no login' }, ['chamados']).includes('verification-loop'))
    assert.ok(skillsSugeridas({ titulo: 'mudar contrato da API' }, ['chamados']).includes('eval-harness'))
  })

  test('componente fora do registro não quebra e ainda entrega o piso', () => {
    const s = skillsSugeridas({ titulo: 'x' }, ['componente-desconhecido'])
    assert.deepEqual(s, ['coding-standards'])
  })

  test('não devolve duplicado nem depende da ordem do array', () => {
    const a = skillsSugeridas({ titulo: 'teste de tela' }, ['portal', 'monitor'])
    const b = skillsSugeridas({ titulo: 'teste de tela' }, ['monitor', 'portal'])
    assert.deepEqual(a, b)
    assert.equal(new Set(a).size, a.length)
  })
})