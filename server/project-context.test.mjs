import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProjectContext } from './project-context.mjs';

test('seleciona o trecho do contexto relevante ao equipamento, mesmo com acentos', () => {
  const entries = [
    { title: 'Comunicados gerais', body: 'Planejamento administrativo.'.repeat(120), extracted_text: '', created_at: '2026-10-24T10:00:00Z' },
    { title: 'Contrato de reatores', body: 'O fabricante dos reatores de Ourolândia é a Alfa. Carla é a interlocutora técnica.', extracted_text: '', created_at: '2026-10-20T10:00:00Z' },
  ];
  const selected = selectProjectContext(entries, 'Quem fabrica o reator em Ourolandia?', 400);
  assert.match(selected, /fabricante dos reatores de Ourolândia é a Alfa/);
  assert.doesNotMatch(selected, /Planejamento administrativo/);
});

test('mantém os acréscimos selecionados em ordem cronológica', () => {
  const entries = [
    { title: 'Atualização', body: 'Reatores de Ourolândia: Carla será a interlocutora.', extracted_text: '', created_at: '2026-10-24T10:00:00Z' },
    { title: 'Contrato', body: 'Reatores de Ourolândia: fabricante Alfa.', extracted_text: '', created_at: '2026-10-20T10:00:00Z' },
  ];
  const selected = selectProjectContext(entries, 'Reatores de Ourolândia', 2000);
  assert.ok(selected.indexOf('fabricante Alfa') < selected.indexOf('Carla será'));
});
