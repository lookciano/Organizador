import test from 'node:test';
import assert from 'node:assert/strict';
import { stationGlossaryBlock } from './stations.mjs';

const registry = [
  { canonical: 'São João do Paraíso', labels: ['São João do Paraíso', 'SJP', 'SE SJP'] },
  { canonical: 'Jussiape (GST)', labels: ['Jussiape (GST)'] },
  { canonical: 'Jussiape (TAESA)', labels: ['Jussiape (TAESA)'] },
];

test('glossário fecha a lista de locais e mostra as grafias aceitas', () => {
  const block = stationGlossaryBlock(registry);
  assert.match(block, /Locais canônicos do projeto/);
  assert.match(block, /- São João do Paraíso \(também citada como: SJP; SE SJP\)/);
  assert.match(block, /Jussiape \(GST\)/);
  assert.equal(stationGlossaryBlock([]), '');
  assert.equal(stationGlossaryBlock(null), '');
});

test('glossário avisa que as frentes de Jussiape são registros separados', () => {
  const block = stationGlossaryBlock(registry);
  assert.match(block, /Frentes distintas na mesma subestação/);
  assert.match(block, /Jussiape \(GST\) e Jussiape \(TAESA\)/);
  // Uma única estação não recebe aviso de escopo.
  assert.doesNotMatch(stationGlossaryBlock([registry[0]]), /Frentes distintas/);
});

test('glossário é estável entre chamadas para servir de prefixo cacheável', () => {
  assert.equal(stationGlossaryBlock(registry), stationGlossaryBlock(registry));
});
