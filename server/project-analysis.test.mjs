import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProjectCorpus,readAllPages,topicPaths,makeChunks,batchBySize,validateFindings,uniqueCandidates,validateMatches,finishComparisons} from './project-analysis.mjs';
import {reportFitsContext,reportReasoningOptions} from './ai.mjs';
import {publicAnalysis} from './analysis-jobs.mjs';

test('full pagination visits records after old 300-record limit and scopes each page',async()=>{
 const rows=Array.from({length:605},(_,i)=>({id:String(i+1).padStart(5,'0')})),calls=[];
 const database={execute:async(sql,args)=>{calls.push(args);assert.equal(args[0],'project-a');return [rows.filter(r=>r.id>args[1]).slice(0,200)];}};
 const result=await readAllPages(database,'scoped SQL','project-a');assert.equal(result.length,605);assert.equal(result.at(-1).id,'00605');assert.equal(calls.length,4);
});
test('long documents are read through the final passage without a global chunk cap',()=>{
 const text='Documento longo. '.repeat(20000)+'EVIDÊNCIA NO FINAL';
 const chunks=makeChunks([{id:'a',kind:'sintese',text}]);assert.ok(chunks.length>24);assert.equal(chunks.map(c=>c.text).join(''),text);assert.match(chunks.at(-1).text,/EVIDÊNCIA NO FINAL/);
 const batches=batchBySize(chunks);assert.deepEqual(batches.flat(),chunks);
});
test('structure paths retain parents and terminate safely on cycles',()=>{
 const paths=topicPaths([{id:'a',title:'Equipamentos',parent_id:null},{id:'b',title:'Cubículos',parent_id:'a'},{id:'c',title:'Ciclo',parent_id:'c'}]);assert.equal(paths.get('b'),'Equipamentos › Cubículos');assert.equal(paths.get('c'),'Ciclo');
});
const candidate={action:'Revisar cubículo',location:'Ceará-Mirim',equipment:'Cubículo',responsible:'',due_date:'',source_numbers:[1]};
test('findings reject incomplete responses and references outside the reviewed batch',()=>{
 assert.throws(()=>validateFindings({complete:false},[1]));assert.throws(()=>validateFindings({complete:true,findings:[{text:'Fato',source_numbers:[999]}],candidates:[]},[1]));
 assert.equal(validateFindings({complete:true,findings:[],candidates:[candidate]},[1]).candidates.length,1);
});
test('candidate consolidation preserves different locations and merges exact references',()=>{
 const results=uniqueCandidates([candidate,{...candidate,source_numbers:[2]},{...candidate,location:'Guaporé'}]);assert.equal(results.length,2);assert.deepEqual(results[0].source_numbers,[1,2]);
});
test('comparison checks every candidate and rejects invented task IDs',()=>{
 const candidates=[{...candidate,id:1},{...candidate,id:2}],tasks=[{id:101}];
 assert.throws(()=>validateMatches({comparisons:[{candidate_id:1,matches:[]}]},candidates,tasks));
 assert.throws(()=>validateMatches({comparisons:[{candidate_id:1,matches:[{task_id:999,relation:'existing',reason:'Inventada'}]},{candidate_id:2,matches:[]}]},candidates,tasks));
 assert.equal(validateMatches({comparisons:candidates.map(c=>({candidate_id:c.id,matches:[]}))},candidates,tasks).length,2);
});
test('unavailable tasks never imply new tasks; completed matches require review',()=>{
 const candidates=[{...candidate,id:1}],match=[{candidate_id:1,matches:[{task_id:101,relation:'existing',reason:'Mesma ação e local.'}]}];
 assert.equal(finishComparisons(candidates,[],[],false)[0].classification,'not_compared');
 assert.equal(finishComparisons(candidates,[],[],true)[0].classification,'possible_new');
 assert.equal(finishComparisons(candidates,match,[{id:101,status:'completed'}],true)[0].classification,'review');
 assert.equal(finishComparisons(candidates,match,[{id:101,status:'pending'}],true)[0].classification,'existing');
});
test('public progress hides model working buffers and makes expired work resumable',()=>{
 const result=publicAnalysis({id:'a',question:'Teste',state:'working',lease_until:'2000-01-01',progress_json:JSON.stringify({phase:'review',total:9,completed:4,tasks:{private:'hidden'},findings:[{text:'hidden'}]}),result_json:null});assert.equal(result.state,'ready');assert.equal(result.progress.completed,4);assert.doesNotMatch(JSON.stringify(result),/hidden/);
});

function corpusFixture() {
 const queries=[],stamp='2026-01-01T00:00:00.000Z';
 const nodes=Array.from({length:605},(_,i)=>({id:String(i+1).padStart(5,'0'),title:`Tópico ${i+1}`,archived:0,parent_id:null}));
 const database={execute:async(sql,args)=>{
  queries.push(sql);assert.equal(args[0],'project-a');let rows=[];
  if(sql.includes('FROM projects WHERE'))return [[{id:'project-a',name:'Projeto A',description:'Descrição'}]];
  if(sql.includes('MAX(updated_at)'))return [[{node_id:'00001',latest_update:'2026-02-01T00:00:00.000Z'}]];
  if(sql.includes('FROM structure_nodes'))rows=nodes;
  else if(sql.includes('FROM project_context_entries')){assert.match(sql,/archived=0/);rows=[{id:'context',title:'Contexto',body:'Relação entre equipamentos e responsáveis.'}];}
  else if(sql.includes('FROM topic_summaries')){assert.match(sql,/n.archived=0/);rows=nodes.map(n=>({...n,node_id:n.id,summary:`Síntese ${n.id}`,analysis_status:'completed',generated_at:stamp}));}
  else if(sql.includes('FROM topic_executive_summaries'))rows=[{node_id:'00001',title:'Resumo',summary:'Resumo executivo',analysis_status:'completed',generated_at:stamp}];
  else if(sql.includes('FROM sources'))rows=[{id:'pending',title:'Documento pendente',analysis_status:'pending'}];
  else if(sql.includes('FROM item_updates'))rows=[{id:'update',summary:'Histórico explicitamente solicitado'}];
  else if(sql.includes('FROM items'))rows=[{id:'item',title:'Assunto',summary:'Registro individual',node_id:'00001'}];
  else assert.fail('Unexpected corpus query');
  const key=sql.includes('s.node_id>?')?'node_id':'id';
  return [rows.filter(r=>r[key]>args[1]).slice(0,200)];
 }};
 return {database,queries};
}
test('default corpus reads every saved summary with context, excludes raw/history text and reports stale or pending sources',async()=>{
 const {database,queries}=corpusFixture(),result=await loadProjectCorpus('project-a',database);
 assert.equal(result.coverage.counts.sintese,605);assert.equal(result.coverage.counts.resumo,1);assert.equal(result.coverage.counts.estrutura,605);
 assert.ok(result.documents.some(d=>d.kind==='sintese'&&d.node_id==='00605'));
 assert.ok(result.documents.some(d=>d.kind==='contexto'&&d.text.includes('Relação entre equipamentos')));
 assert.equal(result.documents.filter(d=>d.kind==='estrutura').length,1);
 assert.ok(result.documents.every(d=>!['assunto','historico','fonte'].includes(d.kind)));
 assert.ok(!queries.some(q=>q.includes('FROM item_updates')));
 assert.ok(queries.filter(q=>q.includes('FROM sources')).every(q=>!q.includes('body')&&!q.includes('file_data')));
 assert.equal(result.coverage.history_included,false);assert.equal(result.coverage.originals_included,false);
 assert.ok(result.coverage.issues.some(i=>i.kind==='fonte'));assert.ok(result.coverage.issues.some(i=>i.message.includes('registros atualizados')));
});
test('explicit history and original requests extend, rather than replace, the living report',async()=>{
 const {database}=corpusFixture(),result=await loadProjectCorpus('project-a',database,{history:true,originals:true});
 for(const kind of ['contexto','estrutura','sintese','resumo','assunto','historico','fonte'])assert.ok(result.documents.some(d=>d.kind===kind),kind);
 assert.equal(result.coverage.history_included,true);assert.equal(result.coverage.originals_included,true);
});

test('direct reading requires a verified capacity with reserved space and respects the smaller provider window',()=>{
 assert.equal(reportFitsContext(400000,{context_length:1048576,top_provider:{context_length:1048576,max_completion_tokens:16000}}),true);
 assert.equal(reportFitsContext(400000,{context_length:1048576,top_provider:{context_length:128000,max_completion_tokens:16000}}),false);
 assert.equal(reportFitsContext(400000,null),false);assert.equal(reportFitsContext(400000,{context_length:1048576,top_provider:{max_completion_tokens:4096}}),false);
 assert.equal(reportFitsContext(900000,{context_length:1048576}),false);
});

test('direct reports disable extra reasoning only when selected model explicitly permits it',()=>{
 const model={supported_parameters:['reasoning'],reasoning:{mandatory:false,supported_efforts:['low','none']}};
 assert.deepEqual(reportReasoningOptions(model,true),{enabled:false});
 assert.deepEqual(reportReasoningOptions(model,false),{effort:'low'});
 assert.deepEqual(reportReasoningOptions({...model,reasoning:{mandatory:true,supported_efforts:['low']}},true),{effort:'low'});
 assert.deepEqual(reportReasoningOptions({...model,reasoning:{mandatory:false,supported_efforts:['low']}},true),{effort:'low'});
 assert.equal(reportReasoningOptions(null,true),undefined);
 assert.equal(reportFitsContext(400000,{context_length:1048576,top_provider:{max_completion_tokens:10000}}),false);
});
