import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNode, extractItems, structurePaths, summarizeTopicHistory } from './ai.mjs';
import { splitForAnalysis } from './file-text.mjs';

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

test('atualização escrita em um tópico permanece nele mesmo quando a IA sugere outra categoria', async () => {
  const item = { existing_item_id: 'item-fora', node_id: 'ouro-spcs', node_confidence: 0.95, title: 'Revisão do cubículo', summary: 'Revisão em andamento', location: 'Ourolândia', discipline: '', supplier: '', responsible: '', status: 'em_andamento', due_date: '', attention: false, confidence: 0.9, evidence: 'Revisão em andamento' };
  await mockAnalysis({ items: [item] }, async (request) => {
    const result = await extractItems({ source: { projectName: 'Teste', title: 'Atualização', body: 'Revisão em andamento' }, nodes: [nodes[2]], existingItems: [], preferredNodeId: 'ouro-cub' });
    assert.equal(result[0].nodeId, 'ouro-cub');
    assert.equal(result[0].existingItemId, '');
    assert.match(request().input[0].content, /tópico escolhido pelo usuário/);
  });
});

test('arquivo de texto longo é analisado em vários trechos sem perder assuntos após o décimo segundo', async () => {
  const fileText = Array.from({ length: 20 }, (_, index) => `[[ITEM ${index + 1}]] Informação sobre o equipamento ${index + 1}. ${'Contexto da reunião. '.repeat(55)}`).join('\n\n');
  assert.ok(splitForAnalysis(fileText).length > 1);
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    const chunk = request.input[1].content[0].text;
    const items = [...chunk.matchAll(/\[\[ITEM (\d+)\]\]/g)].map((match) => ({
      existing_item_id: '', node_id: Number(match[1]) % 2 ? 'ouro-cub' : 'ouro-spcs', node_confidence: 0.95,
      title: `Equipamento ${match[1]}`, summary: `Informação ${match[1]}`, location: 'Ourolândia', discipline: '', supplier: '', responsible: '',
      status: 'em_andamento', due_date: '', attention: false, confidence: 0.95, evidence: `Informação sobre o equipamento ${match[1]}`,
    }));
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] }) };
  };
  try {
    const result = await extractItems({ source: { projectName: 'Teste', title: 'Ata', fileName: 'ata.txt', contentType: 'text/plain', fileData: Buffer.from(fileText), body: '' }, nodes, existingItems: [] });
    assert.ok(calls > 1);
    assert.equal(result.length, 20);
    assert.equal(result[0].nodeId, 'ouro-cub');
    assert.equal(result[19].nodeId, 'ouro-spcs');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test('síntese do tópico percorre todo o histórico e mantém uma mudança sutil', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const result = requests.length === 1
      ? { bullets: [{ item_id: 'a', text: 'Revisão em andamento.' }, { item_id: 'b', text: 'Inspeção continua pendente.' }], important_change: '', changed_item_id: '', change_before: '', change_after: '' }
      : { bullets: [{ item_id: 'a', text: 'Revisão em andamento; o prazo mudou para 22/10.' }], important_change: 'Prazo alterado de 20/10 para 22/10.', changed_item_id: 'a', change_before: 'Prazo era 20/10.', change_after: 'O prazo mudou para 22/10.' };
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
  };
  try {
    const result = await summarizeTopicHistory({
      projectName: 'Teste', topicPath: 'Equipamentos > Cubículos',
      items: [
        { id: 'a', title: 'Cubículo', updated_at: '2026-10-22T10:00:00Z', status: 'em_andamento', summary: 'Prazo 22/10', responsible: '', supplier: '', due_date: '2026-10-22', attention: 0 },
        { id: 'b', title: 'Inspeção', updated_at: '2026-10-22T10:00:00Z', status: 'pendente', summary: 'Aguardando equipe.', responsible: '', supplier: '', due_date: '', attention: 0 },
      ],
      updates: [
        { id: '0', item_id: 'a', created_at: '2026-10-19T10:00:00Z', summary: `Prazo era 20/10. ${'Contexto anterior. '.repeat(330)}`, evidence: '', new_status: 'pendente', source_title: 'Ata 0' },
        { id: '1', item_id: 'a', created_at: '2026-10-20T10:00:00Z', summary: `Revisão em andamento. ${'Contexto repetido. '.repeat(330)}`, evidence: '', new_status: 'em_andamento', source_title: 'Ata 1' },
        { id: '2', item_id: 'a', created_at: '2026-10-21T10:00:00Z', summary: `Revisão em andamento. ${'Contexto repetido. '.repeat(330)}`, evidence: '', new_status: 'em_andamento', source_title: 'Ata 2' },
        { id: '3', item_id: 'a', created_at: '2026-10-22T10:00:00Z', summary: 'O prazo mudou para 22/10.', evidence: 'prazo 22/10', new_status: 'em_andamento', source_title: 'Ata 3' },
      ],
    });
    assert.ok(requests.length > 1);
    assert.ok(requests.some((request) => request.input[1].content[0].text.includes('O prazo mudou para 22/10.')));
    assert.ok(requests.some((request) => request.input[1].content[0].text.includes('Mesma informação repetida 2 vezes')));
    assert.ok(requests[1].input[1].content[0].text.includes('Revisão em andamento.'));
    assert.match(result.summary, /^• Cubículo: Revisão em andamento; o prazo mudou para 22\/10\. \(Situação: em andamento · Prazo: 2026-10-22\)/);
    assert.match(result.summary, /• Inspeção: Inspeção continua pendente\. \(Situação: pendente\)$/);
    assert.equal(result.importantChange, 'Prazo alterado de 20/10 para 22/10.');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test('não destaca uma suposta mudança sem registros anteriores e posteriores comprováveis', async () => {
  await mockAnalysis({ bullets: [{ item_id: 'a', text: 'Entrega prevista para 29/09.' }], important_change: 'Prazo confirmado em 29/09.', changed_item_id: 'a', change_before: 'Prazo era 28/09.', change_after: 'Entrega prevista para 29/09.' }, async () => {
    const result = await summarizeTopicHistory({
      projectName: 'Teste', topicPath: 'Equipamentos > Reatores',
      items: [{ id: 'a', title: 'Reator', updated_at: '2026-10-20T10:00:00Z', status: 'pendente', summary: 'Entrega prevista para 29/09.', responsible: '', supplier: '', due_date: '', attention: 0 }],
      updates: [{ id: '1', item_id: 'a', created_at: '2026-10-20T10:00:00Z', summary: 'Entrega prevista para 29/09.', evidence: '', new_status: 'pendente', source_title: 'Ata' }],
    });
    assert.equal(result.importantChange, '');
  });
});

test('nova síntese recebe a síntese anterior e os registros originais para conferência', async () => {
  await mockAnalysis({ bullets: [{ item_id: 'a', text: 'Entrega segue pendente após revisão do prazo.', locations: [] }], important_change: '', changed_item_id: '', change_before: '', change_after: '' }, async (request) => {
    await summarizeTopicHistory({
      projectName: 'Teste', topicPath: 'Comissionamento > Ourolândia',
      items: [{ id: 'a', title: 'Energização', updated_at: '2026-10-24T10:00:00Z', status: 'pendente', summary: 'Prazo em revisão.', responsible: '', supplier: '', due_date: '', attention: 0 }],
      updates: [{ id: '1', item_id: 'a', created_at: '2026-10-24T10:00:00Z', summary: 'Prazo em revisão.', evidence: '', new_status: 'pendente', source_title: 'Ata' }],
      priorSummaries: [{ generated_at: '2026-10-23T10:00:00Z', summary: '• Energização: prazo anterior de 25/10.' }],
    });
    const prompt = request().input[1].content[0].text;
    assert.match(prompt, /SÍNTESE ANTERIOR/);
    assert.match(prompt, /prazo anterior de 25\/10/);
    assert.match(prompt, /Prazo em revisão/);
  });
});

test('síntese inclui um ponto para todo assunto mesmo quando a IA deixa algum de fora', async () => {
  await mockAnalysis({ bullets: [{ item_id: 'a', text: 'Entrega do equipamento ainda pendente.' }], important_change: '', changed_item_id: '', change_before: '', change_after: '' }, async () => {
    const result = await summarizeTopicHistory({
      projectName: 'Teste', topicPath: 'Equipamentos',
      items: [
        { id: 'a', title: 'Reator', updated_at: '2026-10-20T10:00:00Z', status: 'pendente', summary: 'Entrega em análise.', responsible: 'Ana', supplier: 'Fornecedor A', due_date: '2026-10-25', attention: 1 },
        { id: 'b', title: 'Disjuntor', updated_at: '2026-10-20T10:00:00Z', status: 'em_andamento', summary: 'Testes em andamento.', responsible: 'Bruno', supplier: '', due_date: '', attention: 0 },
      ], updates: [],
    });
    assert.equal(result.summary.split('\n').length, 2);
    assert.match(result.summary, /• Reator: Entrega do equipamento ainda pendente\. \(Situação: pendente · Responsável: Ana · Fornecedor: Fornecedor A · Prazo: 2026-10-25 · Ponto de atenção\)/);
    assert.match(result.summary, /• Disjuntor: Testes em andamento\. \(Situação: em andamento · Responsável: Bruno\)/);
  });
});

test('síntese separa subestações dentro do assunto e preserva locais de trechos anteriores', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const bullet = requests.length === 1
      ? { item_id: 'reatores', text: 'Inspeções em andamento.', locations: [{ name: 'Ourolândia', text: 'Quatro reatores recebidos; inspeção pendente.' }] }
      : { item_id: 'reatores', text: 'Inspeções em andamento.', locations: [{ name: 'Ibicoara', text: 'Dois reatores em transporte.' }] };
    const result = { bullets: [bullet], important_change: '', changed_item_id: '', change_before: '', change_after: '' };
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
  };
  try {
    const result = await summarizeTopicHistory({
      projectName: 'Teste', topicPath: 'Equipamentos > Reatores',
      items: [{ id: 'reatores', title: 'Entrega de reatores', location: 'Ourolândia, Ibicoara', updated_at: '2026-10-20T10:00:00Z', status: 'em_andamento', summary: 'Ourolândia: quatro recebidos; Ibicoara: dois em transporte.', responsible: '', supplier: '', due_date: '', attention: 0 }],
      updates: [
        { id: '1', item_id: 'reatores', created_at: '2026-10-18T10:00:00Z', summary: `Ourolândia: quatro reatores recebidos. ${'Contexto. '.repeat(1000)}`, evidence: '', new_status: 'em_andamento', source_title: 'Ata' },
        { id: '2', item_id: 'reatores', created_at: '2026-10-20T10:00:00Z', summary: 'Ibicoara: dois reatores em transporte.', evidence: '', new_status: 'em_andamento', source_title: 'Ata' },
      ],
    });
    assert.ok(requests.length > 1);
    assert.match(requests[1].input[1].content[0].text, /Ourolândia/);
    assert.match(result.summary, /^• Entrega de reatores: Inspeções em andamento\. \(Situação: em andamento\)/);
    assert.match(result.summary, /\n  ◦ Ourolândia: Quatro reatores recebidos; inspeção pendente\./);
    assert.match(result.summary, /\n  ◦ Ibicoara: Dois reatores em transporte\./);
    assert.doesNotMatch(result.summary, /Local: Ourolândia, Ibicoara/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test('análise complementar separa locais quando a síntese inicial os deixa misturados', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const result = request.text.format.name === 'topic_history_summary'
      ? { bullets: [{ item_id: 'disjuntores', text: 'Ibicoara em transporte; Itabira liberada para entrega.', locations: [] }], important_change: '', changed_item_id: '', change_before: '', change_after: '' }
      : { breakdowns: [{ item_id: 'disjuntores', general_text: 'Entregas em acompanhamento.', locations: [
        { name: 'Ibicoara', text: 'Disjuntores em transporte.' },
        { name: 'Itabira', text: 'Entrega liberada; Fabian deve verificar.' },
      ] }] };
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
  };
  try {
    const result = await summarizeTopicHistory({
      projectName: 'Teste', topicPath: 'Equipamentos > Disjuntores',
      items: [{ id: 'disjuntores', title: 'Entrega de disjuntores', location: 'Ibicoara, Itabira', updated_at: '2026-10-20T10:00:00Z', status: 'em_andamento', summary: 'Ibicoara em transporte; Itabira liberada para entrega.', responsible: 'Fabian', supplier: '', due_date: '', attention: 0 }],
      updates: [],
    });
    assert.equal(requests.length, 2);
    assert.match(requests[1].input[1].content[0].text, /"locais_citados":\["Ibicoara","Itabira"\]/);
    assert.match(result.summary, /• Entrega de disjuntores: Entregas em acompanhamento\. \(Situação: em andamento · Responsável: Fabian\)/);
    assert.match(result.summary, /\n  ◦ Ibicoara: Disjuntores em transporte\./);
    assert.match(result.summary, /\n  ◦ Itabira: Entrega liberada; Fabian deve verificar\./);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
