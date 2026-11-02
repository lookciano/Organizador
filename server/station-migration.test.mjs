import test from 'node:test';
import assert from 'node:assert/strict';
import { planStationChanges } from './station-migration.mjs';

// Estrutura real do projeto Grande Sertão (nomes e hierarquia do banco).
const nodes = [
  { id: 'root', parent_id: null, title: 'Startup e Comissionamento', archived: 0, sort_order: 0 },
  { id: 'startup', parent_id: 'root', title: 'Startup das Subestações', archived: 0, sort_order: 0 },
  { id: 'spcs', parent_id: 'root', title: 'Estudos, SPCS e Proteção — por subestação', archived: 0, sort_order: 1 },
  { id: 'spcs-cm', parent_id: 'spcs', title: 'Ceará-Mirim (Axia)', archived: 0, sort_order: 1 },
  { id: 'spcs-ib', parent_id: 'spcs', title: 'Ibicoara (TAESA)', archived: 0, sort_order: 2 },
  { id: 'spcs-ou', parent_id: 'spcs', title: 'Ourolândia (Argo)', archived: 0, sort_order: 3 },
  { id: 'spcs-jg', parent_id: 'spcs', title: 'Jussiape (GST)', archived: 0, sort_order: 4 },
  { id: 'spcs-jt', parent_id: 'spcs', title: 'Jussiape (TAESA)', archived: 0, sort_order: 5 },
  { id: 'pc', parent_id: 'root', title: 'Projetos Construtivos — por subestação', archived: 0, sort_order: 2 },
  { id: 'pc-cap', parent_id: 'pc', title: 'Capelinha', archived: 0, sort_order: 1 },
  { id: 'pc-ita', parent_id: 'pc', title: 'Itabira', archived: 0, sort_order: 2 },
  { id: 'pc-iga', parent_id: 'pc', title: 'Igaporã', archived: 0, sort_order: 3 },
  { id: 'pc-pil', parent_id: 'pc', title: 'Pilões III', archived: 0, sort_order: 4 },
  { id: 'cub', parent_id: 'root', title: 'Cubículos', archived: 0, sort_order: 3 },
  { id: 'cub-our', parent_id: 'cub', title: 'Ourolândia', archived: 0, sort_order: 1 },
  { id: 'cub-cm', parent_id: 'cub', title: 'Ceará-Mirim', archived: 0, sort_order: 2 },
  { id: 'equip', parent_id: 'root', title: 'Equipamentos', archived: 0, sort_order: 4 },
];

test('plano renomeia para o nome canônico sem tocar nos ramos de disciplina', () => {
  const plan = planStationChanges(nodes);
  assert.deepEqual(plan.problems, []);
  const map = new Map(plan.renames.map((rename) => [rename.id, rename.to]));
  assert.equal(map.get('spcs-cm'), 'Ceará Mirim II');
  assert.equal(map.get('spcs-ib'), 'Ibicoara');
  assert.equal(map.get('spcs-ou'), 'Ourolândia II');
  assert.equal(map.get('pc-cap'), 'Capelinha 3');
  assert.equal(map.get('pc-ita'), 'Itabira 5');
  assert.equal(map.get('pc-iga'), 'Igaporã III');
  assert.equal(map.get('cub-our'), 'Ourolândia II');
  assert.equal(map.get('cub-cm'), 'Ceará Mirim II');
  // Jussiape (GST) e (TAESA) já estão canônicas e continuam distintas.
  assert.equal(map.has('spcs-jg'), false);
  assert.equal(map.has('spcs-jt'), false);
  // Ramos e disciplinas não são renomeados.
  assert.equal(map.has('equip'), false);
  assert.equal(map.has('cub'), false);
  assert.equal(map.has('startup'), false);
});

test('plano cria Extremoz II e Campina Grande III sob Pilões III', () => {
  const plan = planStationChanges(nodes);
  const criadas = plan.creates.map((create) => create.title);
  assert.deepEqual(criadas, ['Extremoz II', 'Campina Grande III']);
  for (const create of plan.creates) assert.equal(create.parent_id, 'pc-pil');
});

test('plano é idempotente: com a estrutura já normalizada não há mudanças', () => {
  const normalizada = nodes.map((node) => {
    if (node.title === 'Ceará-Mirim (Axia)' || node.title === 'Ceará-Mirim') return { ...node, title: 'Ceará Mirim II' };
    if (node.title === 'Ourolândia' || node.title === 'Ourolândia (Argo)') return { ...node, title: 'Ourolândia II' };
    if (node.title === 'Ibicoara (TAESA)') return { ...node, title: 'Ibicoara' };
    if (node.title === 'Igaporã') return { ...node, title: 'Igaporã III' };
    if (node.title === 'Capelinha') return { ...node, title: 'Capelinha 3' };
    if (node.title === 'Itabira') return { ...node, title: 'Itabira 5' };
    return node;
  });
  const comFilhas = [
    ...normalizada,
    { id: 'pc-ext', parent_id: 'pc-pil', title: 'Extremoz II', archived: 0, sort_order: 5 },
    { id: 'pc-cg', parent_id: 'pc-pil', title: 'Campina Grande III', archived: 0, sort_order: 6 },
  ];
  const plan = planStationChanges(comFilhas);
  assert.deepEqual(plan.renames, []);
  assert.deepEqual(plan.creates, []);
});

test('plano aborta quando a renomeação criaria título duplicado sob o mesmo pai', () => {
  const duplicado = [
    { id: 'p', parent_id: null, title: 'Projetos Construtivos — por subestação', archived: 0, sort_order: 0 },
    { id: 'a', parent_id: 'p', title: 'Ceará-Mirim', archived: 0, sort_order: 1 },
    { id: 'b', parent_id: 'p', title: 'Ceará-Mirim II', archived: 0, sort_order: 2 },
  ];
  const plan = planStationChanges(duplicado);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /duplicado/);
});
