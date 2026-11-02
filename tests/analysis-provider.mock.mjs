// Synthetic provider only, imported exclusively by the local integration suite.
const original=globalThis.fetch;
let failed=false;
globalThis.fetch=async(url,options={})=>{
 if(String(url)==='https://openrouter.ai/api/v1/models')return new Response(JSON.stringify({data:[{id:'deepseek/deepseek-v4.1-flash-1017',context_length:process.env.TEST_DIRECT_REPORT==='1'?1048576:8192,top_provider:{context_length:process.env.TEST_DIRECT_REPORT==='1'?1048576:8192,max_completion_tokens:16000},supported_parameters:['reasoning'],reasoning:{mandatory:false,supported_efforts:['low','none']}}]}));
 if(!String(url).startsWith('https://openrouter.ai/api/v1/responses'))return original(url,options);
 const body=JSON.parse(options.body),name=body.text.format.name;
 if(name==='executive_summary')return new Response(JSON.stringify({output_text:JSON.stringify({summary:'Resumo executivo sintético.'})}),{headers:{'Content-Type':'application/json'}});
 const input=JSON.parse(body.input[1].content[0].text);
 const refs=input.chunks?.map(c=>c.number)||[];
 let output;
 if(name==='project_analysis_plan')output={tasks:/compar/i.test(input.question)?'compare':/tarefas/i.test(input.question)?'list':'none',objective:input.question,needs_tasks:/compar|tarefas cadastradas/i.test(input.question),history:/histórico detalhado/i.test(input.question),originals:/documentos originais/i.test(input.question)};
 else if(name==='project_analysis_review'){
  if(process.env.TEST_DIRECT_REPORT==='1')throw new Error('Direct report unexpectedly split into reviews');
  if(input.chunks.some(c=>c.kind==='sintese')&&!input.support.some(f=>/Contexto sintético|Teste contexto a/.test(f.text)))throw new Error('Summary review missing context');
  if(input.plan.objective.includes('pausar')&&!failed){failed=true;return new Response('{}',{status:400});}
  output={complete:true,findings:input.chunks.map(c=>({text:c.kind==='sintese'?'Revisão do TASK-LAST pendente.':'Contexto sintético do projeto A.',source_numbers:[c.number]})),candidates:input.chunks.filter(c=>c.kind==='sintese').map(c=>({action:'Conferir TASK-LAST',location:'Ceará-Mirim',equipment:'Cubículo',responsible:'',due_date:'',source_numbers:[c.number]}))};
 }
 else if(name==='project_analysis_compare')output={comparisons:input.candidates.map(c=>({candidate_id:c.id,matches:input.tasks.filter(t=>t.description.includes('TASK-LAST')).map(t=>({task_id:t.id,relation:'existing',reason:'Mesma ação e local registrados.'}))}))};
 else if(name==='project_analysis_reduce')output={findings:[{text:'Pendência sintetizada do projeto A.',source_numbers:[...new Set(input.findings.flatMap(f=>f.source_numbers))]}]};
 else if(name==='knowledge_answer'&&input.direct){
  if(body.reasoning?.enabled!==false||body.max_output_tokens!==16000||!input.evidence.some(e=>e.passage.includes('TASK-LAST'))||!input.evidence.some(e=>e.passage.includes('Teste contexto a')))throw new Error('Direct report missing full evidence, context or reasoning budget');
  output={complete:!input.question.includes('incompleta'),blocks:[{type:'list',title:'Tarefas propostas',text:'',items:['Conferir TASK-LAST'],columns:[],rows:[],source_numbers:[input.evidence.find(e=>e.passage.includes('TASK-LAST')).number]}]};
 }
 else if(name==='knowledge_answer')output={blocks:[{type:'paragraph',title:'Análise do projeto',text:'Confira a comparação com a sala e as evidências do Relatório vivo.',items:[],columns:[],rows:[],source_numbers:[input.evidence[0].number]}]};
 else throw new Error('Unexpected synthetic provider operation');
 return new Response(JSON.stringify({output_text:JSON.stringify(output)}),{headers:{'Content-Type':'application/json'}});
};
