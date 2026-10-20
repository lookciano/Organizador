import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNode, extractItems, structurePaths } from './ai.mjs';

const nodes = [
  { id: 'equip', parent_id: null, title: 'Equipamentos' },
  { id: 'cub', parent_id: 'equip', title: 'Cubículos' },
  { id: 'ouro-cub', parent_id: 'cub', title: 'Ourolândia' },
  { id: 'spcs', parent_id: null, title: 'Estudos, SPCS e Proteção' },
  { id: 'ouro-spcs', parent_id: 'spcs', title: 'Ourolândia (Argo)' },
];

function mockAnalysis(result, run) {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
  };
  return Promise.resolve().then(() => run(() => request)).finally(() => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
}

test('a estrutura mostra caminhos distintos para os contextos de Ourolândia', () => {
  const paths = structurePaths(nodes);
  assert.equal(paths.find((node) => node.id === 'ouro-cub')?.path, 'Equipamentos > Cubículos > Ourolândia');
  assert.equal(paths.find((node) => node.id === 'ouro-spcs')?.path, 'Estudos, SPCS e Proteção > Ourolândia (Argo)');
});

test('registro manual envia caminhos completos e aceita a classificação segura', async () => {
  await mockAnalysis({ node_id: 'ouro-cub', confidence: 0.94, reason: 'Cubículo em Ourolândia' }, async (request) => {
    const result = await classifyNode({ title: 'Cubículo de Ourolândia', summary: 'Entrega do cubículo', nodes });
    assert.equal(result.nodeId, 'ouro-cub');
    assert.match(request().input[1].content[0].text, /Equipamentos > Cubículos > Ourolândia/);
    assert.match(request().input[1].content[0].text, /Estudos, SPCS e Proteção > Ourolândia \(Argo\)/);
  });
});

test('classificação duvidosa aguarda confirmação humana', async () => {
  await mockAnalysis({ node_id: 'ouro-cub', confidence: 0.54, reason: 'Apenas a localidade foi citada' }, async () => {
    const result = await classifyNode({ title: 'Ourolândia', summary: 'Acompanhamento', nodes });
    assert.equal(result.nodeId, null);
  });
});

test('extração evita atribuir um tópico quando a confiança na categoria é baixa', async () => {
  const item = { existing_item_id: '', node_id: 'ouro-cub', node_confidence: 0.52, title: 'Situação de Ourolândia', summary: 'Revisão em andamento', location: 'Ourolândia', discipline: '', supplier: '', responsible: '', status: 'em_andamento', due_date: '', attention: false, confidence: 0.9, evidence: 'Revisão em andamento' };
  await mockAnalysis({ items: [item] }, async () => {
    const result = await extractItems({ source: { projectName: 'Teste', title: 'Ata', body: 'Revisão em andamento' }, nodes, existingItems: [] });
    assert.equal(result[0].nodeId, null);
  });
});
