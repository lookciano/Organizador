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
const { SecondBrainView, TasksView, CreateProject, TopicSynthesis, ExecutiveSummaryView } = await import(pathToFileURL(`${temporary}/app.mjs`));
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
  const originalFetch = globalThis.fetch; globalThis.fetch = Component===SecondBrainView ? async(url,options)=>{
    if(url.endsWith('/latest'))return reply({analysis:null});
    const response=await fetchMock(url,options);
    if(!response.ok)return response;
    const data=await response.json();
    if(data.state)return reply(data);
    return reply({id:JSON.parse(options?.body || '{}').id || 'job',question:JSON.parse(options?.body || '{}').question,state:'complete',progress:{phase:'complete'},result:data});
  } : fetchMock;
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
 assert.equal(called.url,'/api/projects/a/knowledge/analyses');assert.match(called.body.question,/Ceara Mirim/);
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
const connectedReply=(url)=>url==='/api/chatask/connection'?{connected:true,name:'Conta de teste'}:url==='/api/chatask/rooms'?{rooms:[{id:11,name:'Grande Sertão'},{id:12,name:'Guaporé'}]}:url.endsWith('/chatask')?{room:{id:11,name:'Grande Sertão'},legacyCount:0}:{room:{id:11,name:'Grande Sertão'},tasks:[]};
test('one task workspace reads only linked room tasks, never local or personal tasks',async t=>{
 const calls=[];
 await mount(t,async url=>{calls.push(url);return reply(connectedReply(url));},TasksView);
 assert.ok(calls.includes('/api/projects/a/chatask/tasks'));assert.ok(calls.every(url=>!url.includes('personalTasks')&&!url.endsWith('/a/tasks')));
 assert.match(document.body.textContent,/mesma lista do Chatask/);assert.match(document.body.textContent,/Minhas tarefas/);
});
test('Chatask task creation prevents duplicates and uses the linked room',async t=>{
 const pending=deferred();let posts=0,body;
 await mount(t,async(url,options)=>{if(options?.method==='POST'){posts++;body=JSON.parse(options.body);return pending.promise;}return reply(connectedReply(url));},TasksView);
 await ask('Maria deve revisar o projeto até 15/11/2026');await submit();assert.equal(posts,1);assert.equal(body.roomId,11);assert.ok(body.operationId);
 await act(()=>pending.resolve(reply({created:true})));
 assert.match(document.body.textContent,/Tarefa criada no Chatask/);
});
test('project switch ignores old tasks and discards the creation draft',async t=>{
 const pending=deferred();
 const root=await mount(t,async url=>url==='/api/projects/a/chatask/tasks'?pending.promise:reply(connectedReply(url)),TasksView);
 await act(()=>root.render(createElement(TasksView,{projectId:'b',key:'b'})));
 await act(()=>pending.resolve(reply({tasks:[{id:1,description:'Tarefa antiga'}]})));
 assert.doesNotMatch(document.body.textContent,/Tarefa antiga/);assert.equal(document.querySelector('textarea').value,'');
});
test('disconnected tasks show explicit account connection and no independent task creation',async t=>{
 await mount(t,async url=>reply(url==='/api/chatask/connection'?{connected:false}:{room:null,legacyCount:0}),TasksView,{owner:true});
 assert.match(document.body.textContent,/Conectar minha conta/);assert.equal(document.querySelector('textarea'),null);
 assert.equal(document.querySelector('input[type="password"]').value,'');
});
test('failed creation retains attempt lock until the user checks the list',async t=>{
 await mount(t,async(url,options)=>options?.method==='POST'?new Response(JSON.stringify({error:'Criação não confirmada; confira a lista'}),{status:502}):reply(connectedReply(url)),TasksView);
 await ask('Criar tarefa sintética');assert.match(document.body.textContent,/Criação não confirmada/);
 const refresh=[...document.querySelectorAll('button')].find(b=>b.textContent==='Atualizar');await act(()=>refresh.click());
 assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='Criar tarefa no Chatask').disabled,true);
});
test('new project sends the chosen existing structure and blocks repeated submits',async t=>{
 const pending=deferred();let count=0,body;
 await mount(t,async(url,options)=>{assert.equal(url,'/api/projects');count++;body=JSON.parse(options.body);return pending.promise;},CreateProject,{projects:[{id:'a',name:'Grande Sertão'}],currentProjectId:'a',busy:false,setBusy:()=>{},setError:()=>{},onCreated:()=>{}});
 await input(document.querySelector('input'),'Guaporé');await submit();await submit();assert.equal(count,1);assert.equal(body.structureProjectId,'a');assert.equal(body.withTemplate,false);assert.equal(body.name,'Guaporé');
 await act(()=>pending.resolve(reply({id:'new'})));
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

test('conversation renders a table and sends a bounded follow-up without losing the first answer',async t=>{
 const calls=[];const block={type:'table',title:'Tarefas propostas',text:'',items:[],columns:['Ação','Responsável','Prazo'],rows:[['Revisar cubículo','Maria','Não informado']],source_numbers:[1]};
 const response={status:'answered',blocks:[block],paragraphs:[],sources:[{number:1,id:'s',kind:'sintese',title:'Síntese salva',text:'Maria deve revisar.',created_at:'2026-11-01',part:1}],warnings:[]};
 await mount(t,async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return reply(response);});
 await ask('Crie uma tabela de tarefas com base nas sínteses');
 assert.equal(document.querySelectorAll('table').length,1);assert.match(document.querySelector('tbody').textContent,/Maria/);assert.ok(document.querySelector('[aria-label="Copiar resposta"]'));
 await act(()=>document.querySelector('a').click());assert.equal(document.querySelector('.knowledge-evidence').open,true);assert.equal(document.querySelector('.knowledge-source').open,true);
 await ask('Agora organize por responsável');assert.equal(calls[1].body.history.length,1);assert.match(calls[1].body.history[0].answer,/Maria/);assert.doesNotMatch(calls[1].body.history[0].answer,/Fontes:|\[1\]/);assert.equal(document.querySelectorAll('table').length,2);
 assert.equal(document.querySelectorAll('#knowledge-source-1').length,1);assert.ok(document.querySelector('#knowledge-source-1-1'));
 assert.ok(calls.every(c=>c.url==='/api/projects/a/knowledge/analyses'));
 await act(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Nova conversa').click());
 assert.equal(document.querySelectorAll('table').length,0);await ask('Outra pergunta');assert.deepEqual(calls[2].body.history,[]);
});
test('failed follow-up keeps previous answers and the unsent instruction for retry',async t=>{
 let count=0;await mount(t,async()=>++count===1?reply({status:'answered',paragraphs:[{text:'Primeira resposta',source_numbers:[1]}],sources:[],warnings:[]}):new Response(JSON.stringify({error:'Serviço temporariamente indisponível'}),{status:503}));
 await ask('Resuma a obra');await ask('Agora em lista');assert.match(document.body.textContent,/Primeira resposta/);assert.match(document.body.textContent,/temporariamente/);assert.equal(document.querySelector('textarea').value,'Agora em lista');
});
test('model content is rendered as text and cannot inject HTML or executable links',async t=>{
 await mount(t,async()=>reply({status:'answered',blocks:[{type:'list',title:'<script>alert(1)</script>',text:'',items:['<img src=x onerror=alert(1)>'],columns:[],rows:[],source_numbers:[1]}],paragraphs:[],sources:[],warnings:[]}));
 await ask('Liste as pendências');assert.equal(document.querySelector('script'),null);assert.equal(document.querySelector('img'),null);assert.match(document.body.textContent,/<script>/);
});
test('paused analysis shows saved progress and resumes without creating a second job',async t=>{
 const calls=[];
 await mount(t,async(url,options)=>{
   calls.push(url);
   if(url.endsWith('/advance'))return reply({id:'saved',question:'Compare todas as sínteses',state:'complete',progress:{phase:'complete'},result:{status:'answered',paragraphs:[{text:'Comparação retomada.',source_numbers:[1]}],sources:[],warnings:[]}});
   return reply({id:'saved',question:'Compare todas as sínteses',state:'paused',progress:{phase:'review',completed:22,total:80,error:'Progresso salvo.'},result:null});
 });
 await ask('Compare todas as sínteses');assert.match(document.body.textContent,/22 de 80/);assert.match(document.body.textContent,/Análise pausada/);
 await act(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Retomar análise').click());
 assert.match(document.body.textContent,/Comparação retomada/);assert.equal(calls.filter(u=>u.endsWith('/analyses')).length,1);
});
test('coverage and every candidate remain available beyond the first visible page',async t=>{
 const comparisons=Array.from({length:25},(_,i)=>({id:i+1,action:`Proposta ${i+1}`,location:'Ceará-Mirim',equipment:'Cubículo',responsible:'',due_date:'',source_numbers:[1],classification:'not_compared',matches:[]}));
 await mount(t,async()=>reply({status:'answered',paragraphs:[],sources:[],warnings:[],comparisons,coverage:{snapshot_at:'2026-11-01T12:00:00Z',counts:{sintese:305},issues:[{id:'a',kind:'fonte',title:'Ata pendente',message:'Ainda não organizada.'}],task_status:'unavailable',task_count:null,task_room:'',tasks_read_at:'',task_message:'Conecte sua conta.',originals_included:false,chunks_read:500,chunks_total:500,comparison_requested:true,comparison_complete:false}}));
 await ask('Compare todas as sínteses');assert.equal(document.querySelectorAll('.analysis-candidate').length,20);assert.match(document.body.textContent,/Comparação incompleta/);assert.match(document.body.textContent,/500 de 500/);assert.match(document.body.textContent,/Sínteses: 305/);
 await act(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Mostrar mais propostas')).click());assert.equal(document.querySelectorAll('.analysis-candidate').length,25);assert.match(document.body.textContent,/Proposta 25/);assert.doesNotMatch(document.body.textContent,/Possível nova tarefa/);
});
