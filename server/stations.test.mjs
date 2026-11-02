import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStationRegistry, canonicalStation, canonicalStations, normalizeStation, stationKey, stationListForPrompt } from './stations.mjs';

test('registro canônico traz as 15 subestações e as 2 frentes de Jussiape', () => {
  const registry = buildStationRegistry([]);
  assert.equal(registry.length, 17);
  const names = registry.map((entry) => entry.canonical);
  for (const expected of ['Ceará Mirim II', 'João Pessoa II', 'Pau Ferro', 'Garanhuns II', 'Messias', 'Pilões III',
    'Jussiape', 'São João do Paraíso', 'Capelinha 3', 'Itabira 5', 'Igaporã III', 'Ibicoara', 'Ourolândia II',
    'Extremoz II', 'Campina Grande III', 'Jussiape (GST)', 'Jussiape (TAESA)']) {
    assert.ok(names.includes(expected), `faltou ${expected}`);
  }
});

test('Jussiape (GST) e Jussiape (TAESA) são frentes distintas e não se misturam', () => {
  const registry = buildStationRegistry([]);
  assert.equal(canonicalStation('Jussiape (GST)', registry), 'Jussiape (GST)');
  assert.equal(canonicalStation('Jussiape GST', registry), 'Jussiape (GST)');
  assert.equal(canonicalStation('Jussiape (TAESA)', registry), 'Jussiape (TAESA)');
  assert.equal(canonicalStation('Jussiape TAESA', registry), 'Jussiape (TAESA)');
  assert.equal(canonicalStation('SE Jussiape TAESA lote GS2', registry), 'Jussiape (TAESA)');
  assert.equal(canonicalStation('Jussiape', registry), 'Jussiape');
  assert.notEqual(stationKey('Jussiape (GST)', registry), stationKey('Jussiape (TAESA)', registry));
  // Nas demais estações a empresa é ruído.
  assert.equal(canonicalStation('Ibicoara (TAESA)', registry), 'Ibicoara');
  assert.equal(canonicalStation('Ceará-Mirim (Axia)', registry), 'Ceará Mirim II');
});

test('resolve variações, apelidos, siglas de empresa e erros de grafia', () => {
  const registry = buildStationRegistry([]);
  const cases = [
    ['Ourolândia', 'Ourolândia II'],
    ['Ourolândia II', 'Ourolândia II'],
    ['Ourolândia (Argo)', 'Ourolândia II'],
    ['Ourolandia', 'Ourolândia II'],
    ['Ourilândia', 'Ourolândia II'],
    ['SE Ourolândia II, lote GS3', 'Ourolândia II'],
    ['Ceará-Mirim (Axia)', 'Ceará Mirim II'],
    ['Ceará Mirim', 'Ceará Mirim II'],
    ['Ceará-Mirim II', 'Ceará Mirim II'],
    ['João Pessoa do TAF', 'João Pessoa II'],
    ['João Pessoa', 'João Pessoa II'],
    ['SJP', 'São João do Paraíso'],
    ['Pilões', 'Pilões III'],
    ['Garanhuns', 'Garanhuns II'],
    ['Itabira 5', 'Itabira 5'],
    ['Ibicoara (TAESA)', 'Ibicoara'],
    ['Igaporã', 'Igaporã III'],
    ['Campina Grande III', 'Campina Grande III'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalStation(input, registry), expected, `entrada: ${input}`);
  }
});

test('não inventa subestação quando a menção não é reconhecida', () => {
  const registry = buildStationRegistry([]);
  for (const input of ['varias subestações', 'Painéis QDCA e QDCC', 'TAESA', 'Argo', '', '   ']) {
    assert.equal(canonicalStation(input, registry), '', `entrada: ${input}`);
  }
});

test('título da estrutura vira apelido do grupo canônico', () => {
  const nodes = [
    { id: 'root', parent_id: null, title: 'Startup e Comissionamento' },
    { id: 'startup', parent_id: 'root', title: 'Startup das Subestações' },
    { id: 'n1', parent_id: 'startup', title: 'SE Ourolândia' },
    { id: 'n2', parent_id: 'startup', title: 'Ceará-Mirim (Axia)' },
  ];
  const registry = buildStationRegistry(nodes);
  assert.equal(canonicalStation('SE Ourolândia', registry), 'Ourolândia II');
  assert.equal(canonicalStation('Ceará-Mirim (Axia)', registry), 'Ceará Mirim II');
  assert.equal(canonicalStation('Ourolândia II', registry), 'Ourolândia II');
  assert.equal(canonicalStation('SE Ourolândia', buildStationRegistry([])), 'Ourolândia II');
});

test('estação que existe só na estrutura permanece como nome próprio', () => {
  const nodes = [
    { id: 'startup', parent_id: null, title: 'Startup das Subestações' },
    { id: 'x', parent_id: 'startup', title: 'SE Nova Fronteira' },
  ];
  const registry = buildStationRegistry(nodes);
  assert.equal(canonicalStation('Nova Fronteira', registry), 'SE Nova Fronteira');
});

test('lista para prompt mostra canônico e variações conhecidas', () => {
  const registry = buildStationRegistry([]);
  const text = stationListForPrompt(registry);
  assert.match(text, /- Ourolândia II \(também citada como: Ourolândia/);
  assert.match(text, /- Pau Ferro$/m);
  assert.equal(text.split('\n').length, 17);
});

test('stationKey agrupa variantes na mesma chave', () => {
  const registry = buildStationRegistry([]);
  const keys = new Set(['Ourolândia', 'Ourolândia II', 'Ourolândia (Argo)', 'Ourolandia'].map((value) => stationKey(value, registry)));
  assert.equal(keys.size, 1);
  assert.equal(normalizeStation('Ourolândia II'), 'ourolandia ii');
});

test('menção com várias subestações é desdobrada', () => {
  const registry = buildStationRegistry([]);
  assert.deepEqual(canonicalStations('Jussiape, Ibicoara e Igaporã', registry), ['Jussiape', 'Ibicoara', 'Igaporã III']);
  assert.deepEqual(canonicalStations('Ceará-Mirim, Messias', registry), ['Ceará Mirim II', 'Messias']);
  assert.deepEqual(canonicalStations('Jussiape', registry), ['Jussiape']);
  assert.deepEqual(canonicalStations('Painéis QDCA e QDCC', registry), []);
  assert.deepEqual(canonicalStations('', registry), []);
});
