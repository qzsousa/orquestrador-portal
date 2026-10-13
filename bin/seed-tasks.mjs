#!/usr/bin/env node
/**
 * Seed do lote de trabalho do portal.
 *
 * Por que existe: as tasks vivem em `.state/tasks.json`, que é gitignored — é
 * estado de execução, não fonte. Num segundo computador (ou depois de um
 * Ctrl+C) esse arquivo não vem junto no `git clone`. Este script é a versão
 * versionada da fila: um comando recria as tasks, com os mesmos textos,
 * critérios e ordem, em qualquer máquina.
 *
 * Por que não são comandos `orq add` soltos: o `--crit` do CLI quebra por
 * `;`, e os critérios dessas tasks têm `;` dentro do texto. Aqui os Criteria
 * são arrays, sem regra de escape.
 *
 * Idempotente. Rodar duas vezes não duplica nada: uma task cujo título já
 * existe no estado é pulada e reportada.
 *
 *   node bin/seed-tasks.mjs            recria as que faltam
 *   node bin/seed-tasks.mjs --lista    só mostra o que existe no estado
 */

import { TaskStore } from '../src/core/taskstore.mjs'
import { carregarConfig } from '../src/core/config.mjs'

/**
 * Ordem importa: o store numera sequencialmente (T-001, T-002, ...), e essa
 * numeração é a mesma das branches `orq/T-00N-*`. Inverter a lista troca os
 * ids em cima de branches já criadas.
 */
const TASKS = [
  {
    titulo:
      'Filtros por modelo/marca na tela de equipamentos + lista de escolas que possuem o modelo',
    componentes: ['portal'],
    prioridade: 4,
    arquivosAlvo: [
      'src/views/EquipamentosView.vue',
      'src/composables/useEquipamentos.ts',
      'src/api/sce.ts',
    ],
    criterios: [
      'A tela /equipamentos tem filtro por modelo e por marca, alem do que ja existe',
      'Existe uma visao que lista as escolas que possuem determinado modelo, com a quantidade de equipamentos de cada escola',
      'O filtro roda no servidor do SCE (parametros modelo/marca/categoria), nao baixando a lista inteira para filtrar no navegador',
      'A lista de escolas usa o agregado porUnidade que o SCE ja devolve, sem recalcular',
    ],
  },
  {
    titulo:
      'Fluxo de recuperacao de senha: gestor abre chamado publico, ADMIN gera codigo em /usuarios e responde o proprio chamado',
    componentes: ['portal'],
    prioridade: 4,
    arquivosAlvo: [
      'src/views/publico/NovoChamadoView.vue',
      'src/views/ChamadosView.vue',
      'src/views/UsuariosView.vue',
      'src/api/chamados.ts',
      'src/api/usuarios.ts',
    ],
    criterios: [
      'No formulario publico de novo chamado existe uma forma de o gestor sinalizar que esqueceu a senha de acesso',
      'A tela /usuarios permite ao ADMIN gerar o codigo de primeiro acesso do usuario que abriu o chamado, sem sair do fluxo',
      'O ADMIN responde o chamado com o codigo gerado, usando o fluxo de resposta de chamado que ja existe',
      'Quando o gestor consulta o protocolo, a resposta com o codigo aparece junto do chamado',
      'Nao expõe a senha do usuario em log, tela ou resposta; o que circula é o codigo de primeiro acesso',
    ],
  },
  {
    titulo:
      'Backend de condicoes e anexos do formulario de chamados (contrato que o portal ja consome)',
    descricao:
      'Backend de condicoes e anexos do formulario de chamados (contrato que o portal ja consome).\n\n' +
      'ATENÇÃO: o backend já foi implementado e commitado (chamados@99698d8, ' +
      'feat(formulario): condicoes de exibicao e anexos nas perguntas). Antes de ' +
      'implementar, verifique o que ainda falta — principalmente se a migration ' +
      'rodou e se os testes novos existem. Não refaça o que já está commitado.',
    componentes: ['chamados'],
    prioridade: 5,
    arquivosAlvo: [
      'backend/prisma/schema.prisma',
      'backend/src/routes/formulario.ts',
      'backend/src/routes/chamados.ts',
      'backend/prisma/migrations/',
    ],
    criterios: [
      'O backend aceita e devolve condicoes[] em perguntas, com os tipos ESCOLA e ARQUIVO e o campo exigeAnexo',
      'Existe migration que cria as colunas e tipos novos',
      'Os testes do backend passam (hoje ha falhas pre-existentes que precisam ser separadas das novas)',
      'O contrato casa exatamente com o que o portal consome em src/api/formulario.ts',
    ],
  },
]

const lista = process.argv.includes('--lista')

const cfg = await carregarConfig()
const store = new TaskStore(cfg.stateDir)

if (lista) {
  const ativas = store.ativas()
  if (!ativas.length) {
    console.log('Nenhuma task no estado.')
  }
  for (const t of store.listar()) {
    console.log(`${t.id}  [${t.estado}]  ${t.titulo}`)
  }
  process.exit(0)
}

const existentes = new Set(store.listar().map((t) => t.titulo.trim()))
let criadas = 0
let puladas = 0

for (const entrada of TASKS) {
  if (existentes.has(entrada.titulo.trim())) {
    console.log(`- ${entrada.titulo.slice(0, 60)}... já existe, pulada`)
    puladas++
    continue
  }
  const t = store.criar({
    ...entrada,
    origem: { tipo: 'seed', ref: 'bin/seed-tasks.mjs' },
  })
  console.log(`✓ ${t.id} ${t.titulo}`)
  criadas++
}

console.log(`\n${criadas} criada(s), ${puladas} pulada(s).`)
console.log('Rode "orq plan" para ver dependências e conflitos.')