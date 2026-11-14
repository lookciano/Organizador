import test from 'node:test';
import assert from 'node:assert/strict';
import { changedSummaryItems, parseLegacySummary } from './summary-state.mjs';

test('recupera a síntese legada por assunto e subestação sem consultar a IA', () => {
  const items = [
    { id: 'a', title: 'Disjuntor', location: 'Ourolândia', node_path: 'Equipamentos > Ourolândia', created_at: '2026-10-01T10:00:00Z' },
    { id: 'b', title: 'Reator', location: 'Ibicoara', node_path: 'Equipamentos > Ibicoara', created_at: '2026-10-01T10:00:00Z' },
  ];
  const summary = '• Subestação Ourolândia — última informação em 02/10/2026\n  ◦ Disjuntor: ensaio pendente com Ana (Última informação: 02/10/2026)\n• Subestação Ibicoara — última informação em 03/10/2026\n  ◦ Reator: laudo recebido (Última informação: 03/10/2026)';
  assert.deepEqual(parseLegacySummary(summary, items, true, '2026-10-04T10:00:00Z'), [
    { item_id: 'a', text: 'Acompanhamento por local.', locations: [{ name: 'Ourolândia', text: 'ensaio pendente com Ana' }] },
    { item_id: 'b', text: 'Acompanhamento por local.', locations: [{ name: 'Ibicoara', text: 'laudo recebido' }] },
  ]);
  assert.deepEqual([...changedSummaryItems(items, [{ item_id: 'b', created_at: '2026-10-05T10:00:00Z' }], parseLegacySummary(summary, items, true, '2026-10-04T10:00:00Z'), '2026-10-04T10:00:00Z')], ['b']);
});

test('linha ambígua impede recuperação silenciosa com perda de fatos', () => {
  const items = [{ id: 'a', title: 'Reator' }, { id: 'b', title: 'Reator' }];
  assert.equal(parseLegacySummary('• Reator: pendente (Situação: pendente)', items, false), null);
});
