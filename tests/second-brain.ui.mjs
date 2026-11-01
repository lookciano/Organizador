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
const { SecondBrainView, TasksView, TopicSynthesis, ExecutiveSummaryView } = await import(pathToFileURL(`${temporary}/app.mjs`));
test.after(() => rm(temporary, { recursive: true, force: true }));
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function input(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function mount(t, fetchMock, Component=SecondBrainView, props={}) {
  const originalFetch = globalThis.fetch; globalThis.fetch = fetchMock;
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await act(() => root.unmount()); globalThis.fetch = originalFetch; });
  await act(() => root.render(createElement(Component, { projectId:'a',items:[],key:'a',...props })));
  return root;
}
async function submit() {await act(()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));}
async function ask(value) {
 await act(()=>{const element=document.querySelector('textarea');Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 await submit();
}
test('natural-language question uses the AI endpoint, shows citations and has no task form',async t=>{
 let called;
 await mount(t,async(url,options)=>{called={url,body:JSON.parse(options.body)};return reply({status:'answered',paragraphs:[{text:'O cubículo foi entregue.',source_numbers:[1]}],sources:[{number:1,id:'a',kind:'assunto',title:'Cubículo Ceará-Mirim',text:'Entregue.',created_at:'2026-11-01',part:1}],warnings:[]});});
 await ask('me fala tudo sobre o cubículo de Ceara Mirim');
 assert.equal(called.url,'/api/projects/a/knowledge/ask');assert.match(called.body.question,/Ceara Mirim/);
 assert.match(document.body.textContent,/O cubículo foi entregue/);assert.equal(document.querySelector('a').getAttribute('href'),'#knowledge-source-1');
 assert.equal(document.querySelector('[aria-label="Nova tarefa"]'),null);
});
test('an ongoing AI question prevents duplicate requests and is reset on project change',async t=>{
 const pending=deferred();let count=0;
 const root=await mount(t,async()=>{count++;return pending.promise;});
 await ask('Cubículo Ceará Mirim');await submit();assert.equal(count,1);assert.equal(document.querySelector('button').disabled,true);
 await act(()=>root.render(createElement(SecondBrainView,{projectId:'b',key:'b'})));
 await act(()=>pending.resolve(reply({status:'answered',paragraphs:[{text:'Resposta do projeto A',source_numbers:[1]}],sources:[],warnings:[]})));
 assert.doesNotMatch(document.body.textContent,/Resposta do projeto A/);assert.equal(document.querySelector('textarea').value,'');
});
test('unavailable AI is clearly distinguished from no evidence and short questions are rejected',async t=>{
 let calls=0;
 await mount(t,async()=>{calls++;return reply({status:'unavailable',paragraphs:[],sources:[],warnings:['Não foi possível gerar a resposta agora.']});});
 await ask('a');assert.equal(calls,0);assert.match(document.body.textContent,/pelo menos três/);
 await ask('Cubículo');assert.equal(calls,1);assert.match(document.body.textContent,/Não foi possível gerar a resposta/);assert.doesNotMatch(document.body.textContent,/Nenhum resultado encontrado/);
});
test('independent task workspace prevents double submission',async t=>{
 const saving=deferred();let posts=0;
 await mount(t,async(_url,options)=>{if(options?.method==='POST'){posts++;return saving.promise;}return reply({tasks:[]});},TasksView);
 await input(document.querySelector('[aria-label="Nova tarefa"]'),'Tarefa de teste');await submit();await submit();
 assert.equal(posts,1);assert.equal(document.querySelector('form button').disabled,true);
 await act(()=>saving.resolve(reply({id:'task'})));assert.equal(document.querySelector('[aria-label="Nova tarefa"]').value,'');
 assert.doesNotMatch(document.body.textContent,/Pergunte ao projeto/);
});
test('switching projects clears the task draft and ignores the old task list',async t=>{
 const old=deferred();
 const root=await mount(t,async url=>url.includes('/a/')?old.promise:reply({tasks:[{id:'b',title:'Tarefa B',status:'pendente'}]}),TasksView);
 await input(document.querySelector('[aria-label="Nova tarefa"]'),'Rascunho A');
 await act(()=>root.render(createElement(TasksView,{projectId:'b',items:[],key:'b'})));
 await act(()=>old.resolve(reply({tasks:[{id:'a',title:'Tarefa A',status:'pendente'}]})));
 assert.match(document.body.textContent,/Tarefa B/);assert.doesNotMatch(document.body.textContent,/Tarefa A/);assert.equal(document.querySelector('[aria-label="Nova tarefa"]').value,'');
});
test('copy controls copy the complete synthesis and executive summary with feedback',async t=>{
 const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');let copied='';
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{copied=text;}}}});
 t.after(()=>{if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;});
 const value={summary:'• Ceará-Mirim: entregue.\n◦ Falta colocar na base.',important_change:'Entrega confirmada.',analysis_status:'done'};
 const root=await mount(t,async()=>reply({}),TopicSynthesis,{value,onRetry:async()=>{}});
 await act(async()=>{document.querySelector('[aria-label="Copiar síntese"]').click();await Promise.resolve();});
 assert.equal(copied,value.summary+'\n\nMudança relevante\nEntrega confirmada.');assert.match(document.body.textContent,/Copiado/);
 await act(()=>root.render(createElement(ExecutiveSummaryView,{value:{summary:'Resumo completo.',analysis_status:'done'},onRetry:async()=>{}})));
 await act(async()=>{document.querySelector('[aria-label="Copiar resumo executivo"]').click();await Promise.resolve();});assert.equal(copied,'Resumo completo.');
});
test('copy failure gives honest feedback and no button appears without a summary',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw Error('denied');}}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;});
 const root=await mount(t,async()=>reply({}),ExecutiveSummaryView,{value:{summary:'Texto',analysis_status:'done'},onRetry:async()=>{}});
 await act(async()=>{document.querySelector('[aria-label="Copiar resumo executivo"]').click();await Promise.resolve();});assert.match(document.body.textContent,/Não foi possível copiar/);
 await act(()=>root.render(createElement(ExecutiveSummaryView,{onRetry:async()=>{}})));assert.equal(document.querySelector('[aria-label="Copiar resumo executivo"]'),null);
});
