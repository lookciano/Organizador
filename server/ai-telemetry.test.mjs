import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProjectBatch } from './ai.mjs';

test('cada chamada registra tokens, cache e duração sem vazar conteúdo', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.OPENROUTER_MODEL;
  const previousInfo = console.info;
  const logs = [];
  const model = 'test/telemetry-unique';
  process.env.OPENROUTER_API_KEY = 'synthetic-key';
  process.env.OPENROUTER_MODEL = model;
  console.info = (...args) => logs.push(args);
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: model, context_length: 200000, supported_parameters: ['reasoning'], reasoning: { mandatory: false, supported_efforts: ['low', 'none'] } }] }) };
    }
    return {
      ok: true,
      json: async () => ({
        status: 'completed',
        output_text: JSON.stringify({ complete: true, findings: [], candidates: [] }),
        usage: { input_tokens: 4200, input_tokens_details: { cached_tokens: 3600 }, output_tokens: 180, output_tokens_details: { reasoning_tokens: 0 } },
      }),
    };
  };
  const plan = { tasks: 'none', objective: 'resumir', needs_tasks: false, history: false, originals: false };
  try {
    await reviewProjectBatch(plan, [{ number: 1, kind: 'sintese', id: 'a', title: 'SEGREDO DO PROJETO', text: 'CONTEUDO PRIVADO DO REGISTRO' }], [], []);
    const line = logs.find((args) => args[0] === 'ai_call:');
    assert.ok(line, 'esperava uma linha ai_call');
    const info = JSON.parse(line[1]);
    assert.equal(info.name, 'project_analysis_review');
    assert.equal(info.attempt, 1);
    assert.equal(info.input_tokens, 4200);
    assert.equal(info.cached_tokens, 3600);
    assert.equal(info.output_tokens, 180);
    assert.equal(info.reasoning_tokens, 0);
    assert.equal(info.status, 'completed');
    assert.equal(typeof info.duration_ms, 'number');
    assert.ok(info.duration_ms >= 0);
    // Sem registro de estações o raciocínio continua desligado na extração.
    assert.equal(info.reasoning, 'false');
    // Só números e categorias: nada de pergunta, registro ou chave.
    assert.doesNotMatch(JSON.stringify(logs), /SEGREDO|CONTEUDO PRIVADO|synthetic-key/);
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = previousModel;
  }
});
