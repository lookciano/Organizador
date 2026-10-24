import test from 'node:test';
import assert from 'node:assert/strict';
import { exportStructureCsv, planStructureImport } from './structure-csv.mjs';

const nodes = [
  { id: 'root', parent_id: null, title: 'Comissionamento', sort_order: 0, archived: 0 },
  { id: 'station', parent_id: 'root', title: 'Ourolândia', sort_order: 0, archived: 0 },
  { id: 'other', parent_id: null, title: 'Projetos; "geral"', sort_order: 1, archived: 0 },
];

test('planilha preserva acentos, ponto e vírgula e IDs, e permite criar e mover tópicos', () => {
  const exported = exportStructureCsv(nodes);
  assert.match(exported, /^\ufeffcodigo;id;codigo_pai/);
  const edited = exported.replace('N002;station;N001;Ourolândia;0;0', 'N002;station;N003;Ourolândia;1;0')
    .trimEnd() + '\r\nN004;;N001;João Pessoa II;2;0;\r\n';
  const plan = planStructureImport(edited, nodes);
  assert.equal(plan.rows.length, 4);
  assert.equal(plan.rows.find((row) => row.id === 'station').parentCode, 'N003');
  assert.deepEqual(plan.changes.map((entry) => entry.kind), ['mover, reordenar', 'criar']);
});

test('planilha impede perda de tópicos e ciclos', () => {
  const exported = exportStructureCsv(nodes);
  assert.throws(() => planStructureImport(exported.split('\r\n').slice(0, -2).join('\r\n'), nodes), /todas as categorias/);
  assert.throws(() => planStructureImport(exported.replace('N001;root;;', 'N001;root;N002;'), nodes), /ciclo/);
  assert.throws(() => planStructureImport(exported.replace('N002;station;', 'N002;desconhecido;'), nodes), /ID desconhecido/);
});
