import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
await mkdir('node_modules/.cache', { recursive: true });
const temporary = await mkdtemp(resolve('node_modules/.cache/brain-test-'));
await build({ entryPoints: ['src/App.tsx'], outfile: `${temporary}/app.mjs`, bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent' });
const { SecondBrainView } = await import(pathToFileURL(`${temporary}/app.mjs`));
test.after(() => rm(temporary, { recursive: true, force: true }));
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function input(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function mount(t, fetchMock) {
  const originalFetch = globalThis.fetch; globalThis.fetch = fetchMock;
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await act(() => root.unmount()); globalThis.fetch = originalFetch; });
  await act(() => root.render(createElement(SecondBrainView, { projectId: 'a', items: [], key: 'a' })));
  return root;
}
async function search(value) {
  await input(document.querySelector('[aria-label="Busca de conhecimento"]'), value);
  await act(() => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
}
test('a slow old search cannot replace the latest search results', async t => {
  const first = deferred(), second = deferred();
  await mount(t, async url => url.endsWith('/tasks') ? reply({ tasks: [] }) : String(url).includes('Primeira') ? first.promise : second.promise);
  await search('Primeira'); await search('Segunda');
  await act(async () => second.resolve(reply({ results: [{ id: '2', kind: 'assunto', title: 'Resultado atual' }] })));
  await act(async () => first.resolve(reply({ results: [{ id: '1', kind: 'assunto', title: 'Resultado antigo' }] })));
  assert.match(document.body.textContent, /Resultado atual/); assert.doesNotMatch(document.body.textContent, /Resultado antigo/);
});
test('double submission sends only one task creation request', async t => {
  const saving = deferred(); let posts = 0;
  await mount(t, async (_url, options) => { if(options?.method === 'POST') { posts++; return saving.promise; } return reply({ tasks: [] }); });
  await input(document.querySelector('[aria-label="Nova tarefa"]'), 'Tarefa de teste');
  const form = document.querySelectorAll('form')[1];
  await act(() => { for(let i=0;i<2;i++) form.dispatchEvent(new dom.window.Event('submit', { bubbles:true,cancelable:true })); });
  assert.equal(posts, 1); assert.equal(form.querySelector('button').disabled, true);
  await act(async () => saving.resolve(reply({ id: 'task' })));
  assert.equal(form.querySelector('button').disabled, false); assert.equal(document.querySelector('[aria-label="Nova tarefa"]').value, '');
});
test('switching project clears task drafts and ignores responses from the old component', async t => {
  const old = deferred();
  const root = await mount(t, async url => String(url).includes('/a/') ? old.promise : reply({ tasks: [{ id: 'b', title: 'Tarefa B', status: 'pendente' }] }));
  await input(document.querySelector('[aria-label="Nova tarefa"]'), 'Rascunho A');
  await act(() => root.render(createElement(SecondBrainView, { projectId:'b',items:[],key:'b' })));
  await act(async () => old.resolve(reply({ tasks: [{ id:'a',title:'Tarefa A',status:'pendente' }] })));
  assert.match(document.body.textContent,/Tarefa B/); assert.doesNotMatch(document.body.textContent,/Tarefa A/);
  assert.equal(document.querySelector('[aria-label="Nova tarefa"]').value,'');
});
test('a short query clears stale search results and explains the minimum length', async t => {
  await mount(t, async url => url.endsWith('/tasks') ? reply({tasks:[]}) : reply({results:[{id:'1',kind:'fonte',title:'Resultado anterior'}]}));
  await search('Teste'); assert.match(document.body.textContent,/Resultado anterior/);
  await search('a'); assert.doesNotMatch(document.body.textContent,/Resultado anterior/);
  assert.match(document.body.textContent,/pelo menos dois caracteres/);
});
