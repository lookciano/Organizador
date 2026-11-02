import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';
import { readChataskProjectTasks } from './chatask.mjs';
import { validateConversation } from './knowledge.mjs';
import { loadProjectCorpus,makeChunks,batchBySize,validateFindings,uniqueCandidates,validateMatches,finishComparisons,taskDocuments,revisionOf,validateKnowledgeBlocks } from './project-analysis.mjs';
import { planProjectAnalysis,reviewProjectBatch,compareProjectTasks,reduceProjectFindings,answerKnowledgeQuestion,canAnswerProjectDirectly } from './ai.mjs';

const now=()=>new Date().toISOString();
const json=value=>typeof value==='string'?JSON.parse(value):value;
const leaseEnd=()=>new Date(Date.now()+300000).toISOString();
const apiPath='/api/projects/:projectId/knowledge/analyses';
const active=new Set();
export function publicAnalysis(row) {
  const p=json(row.progress_json);
  return {id:row.id,question:row.question,state:row.state==='working'&&row.lease_until<now()?'ready':row.state,
    progress:{phase:p.phase,completed:p.completed||0,total:p.total||0,comparisons_completed:p.compareIndex||0,comparisons_total:p.compareTotal||0,error:p.error||'',notice:p.notice||'',coverage:p.coverage||null},
    result:row.result_json?json(row.result_json):null};
}
async function checkpoint(id,token,progress,changes=async()=>{},result=null) {
  const sql=await db().getConnection();
  try {
    await sql.beginTransaction();
    const [[row]]=await sql.execute('SELECT state,lease_token FROM knowledge_analyses WHERE id=? FOR UPDATE',[id]);
    if(row?.state!=='working'||row.lease_token!==token){await sql.rollback();return false;}
    await changes(sql);
    await sql.execute('UPDATE knowledge_analyses SET state=?,progress_json=?,result_json=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?',[result?'complete':'ready',JSON.stringify(progress),result?JSON.stringify(result):null,now(),id]);
    await sql.commit();return true;
  }catch(error){await sql.rollback();throw error;}finally{sql.release();}
}
async function sourcesFor(id) {
  const [rows]=await db().execute('SELECT sequence_number,source_json,body FROM knowledge_analysis_chunks WHERE analysis_id=? ORDER BY sequence_number',[id]);
  return rows.map(r=>({...json(r.source_json),number:r.sequence_number,text:r.body}));
}
async function performStep(row,token,session) {
  const p=json(row.progress_json),history=json(row.history_json),options=json(row.options_json);
  delete p.error;
  // Replan unfinished older jobs on their next advance. Completed evidence is retained.
  if(p.version!==2){await checkpoint(row.id,token,{version:2,phase:'plan',notice:'A análise foi adaptada para priorizar as sínteses e os resumos atuais, considerando o contexto.'});return;}
  if(p.phase==='plan') {
    p.plan=await planProjectAnalysis(row.question,history);p.phase='prepare';p.reviewSize=32000;
    console.info('project_analysis_scope:',JSON.stringify({tasks:p.plan.tasks,needs_tasks:p.plan.needs_tasks,history:p.plan.history,originals:options.originals||p.plan.originals}));
    await checkpoint(row.id,token,p);return;
  }
  if(!p.directChecked&&['context','review','support_reduce'].includes(p.phase)) {
    p.directChecked=true;
    if(p.plan.tasks!=='compare'&&await canAnswerProjectDirectly(row.question,await sourcesFor(row.id),history,p.coverage)){p.phase='answer_direct';}
    await checkpoint(row.id,token,p);return;
  }
  if(p.phase==='prepare') {
    const started=Date.now();
    let corpus;const connection=await db().getConnection();
    try{await connection.beginTransaction();corpus=await loadProjectCorpus(row.project_id,connection,{originals:options.originals||p.plan.originals,history:p.plan.history});await connection.commit();}
    catch(error){await connection.rollback();throw error;}finally{connection.release();}
    console.info('project_analysis_corpus:', 'duration_ms',Date.now()-started,'documents',corpus.documents.length,'characters',corpus.documents.reduce((n,d)=>n+d.text.length,0));
    let taskSnapshot={tasks:[],available:false};
    const needsTasks=p.plan.needs_tasks||p.plan.tasks==='compare';
    if(needsTasks){
      try{taskSnapshot={...await readChataskProjectTasks(row.project_id,row.user_id,session),available:true};}
      catch(error){corpus.coverage.task_message=error.status?error.message:'Não foi possível consultar as tarefas da sala.';}
    }
    // Comparisons already read every room task; do not read that same list twice.
    const chunks=makeChunks([...corpus.documents,...(taskSnapshot.available&&p.plan.tasks!=='compare'?taskDocuments(taskSnapshot):[])]);
    p.coverage={...corpus.coverage,task_status:!needsTasks?'not_requested':taskSnapshot.available?'read':'unavailable',task_count:taskSnapshot.available?taskSnapshot.tasks.length:null,task_room:taskSnapshot.room?.name||'',tasks_read_at:taskSnapshot.read_at||'',revision:revisionOf(chunks)};
    p.supportPending=chunks.filter(c=>['projeto','estrutura','contexto'].includes(c.kind)).map(c=>c.number);p.supportNotes=[];
    p.tasks=taskSnapshot;p.total=chunks.length;p.completed=0;p.phase='context';
    const context=chunks.filter(c=>p.supportPending.includes(c.number)).map(c=>({text:`${c.title}\n${c.text}`,source_numbers:[c.number]}));
    // Small context travels intact with the summaries; no preliminary LLM rewrite.
    if(p.supportPending.length<chunks.length&&JSON.stringify(context).length<=48000){p.supportNotes=context;p.rawSupport=true;p.phase='review';}
    await checkpoint(row.id,token,p,async sql=>{
      await sql.execute('DELETE FROM knowledge_analysis_chunks WHERE analysis_id=?',[row.id]);
      for(let start=0;start<chunks.length;start+=50){
        const batch=chunks.slice(start,start+50);
        await sql.execute(`INSERT INTO knowledge_analysis_chunks (analysis_id,sequence_number,source_json,body) VALUES ${batch.map(()=>'(?,?,?,?)').join(',')}`,batch.flatMap(c=>{const {text,...meta}=c;return [row.id,c.number,JSON.stringify(meta),text];}));
      }
    });return;
  }
  if(p.phase==='answer_direct') {
    const sources=await sourcesFor(row.id),coverage={...p.coverage,read_method:'direct',chunks_read:p.total,chunks_total:p.total,comparison_requested:false,comparison_complete:false};
    let generated;
    try{generated=await answerKnowledgeQuestion(row.question,sources,history,coverage,true);}
    catch(error){
      if(!/A IA (não concluiu|devolveu JSON incompleto)/.test(error.message))throw error;
      generated={complete:false};
    }
    if(generated.complete!==true)throw Object.assign(new Error('Resposta direta incompleta.'),{code:'DIRECT_ANSWER_INCOMPLETE'});
    const blocks=validateKnowledgeBlocks(generated,sources),cited=new Set(blocks.flatMap(b=>b.source_numbers));
    const warnings=p.coverage.issues.length?['Há conteúdo pendente ou sem atualização confirmada. Confira a cobertura abaixo.']:[];
    if(p.plan.needs_tasks&&!p.tasks.available)warnings.push(p.coverage.task_message||'A lista da sala não pôde ser consultada.');
    const result={status:'answered',blocks,paragraphs:[],sources:sources.filter(s=>cited.has(s.number)),warnings,coverage,comparisons:[],task_mode:p.plan.tasks};
    await checkpoint(row.id,token,{phase:'complete',coverage,completed:p.total,total:p.total},async sql=>{await sql.execute('UPDATE knowledge_analysis_chunks SET reviewed=1 WHERE analysis_id=?',[row.id]);},result);return;
  }
  if(p.phase==='review'||p.phase==='context') {
    const isContext=p.phase==='context';
    if(isContext&&!p.supportPending.length){p.phase='support_reduce';await checkpoint(row.id,token,p);return;}
    const scoped=isContext||Boolean(p.rawSupport&&p.supportPending.length);
    const scope=scoped?` AND sequence_number ${isContext?'IN':'NOT IN'} (${p.supportPending.map(()=>'?').join(',')})`:'';
    const [pending]=await db().execute(`SELECT sequence_number,source_json,body FROM knowledge_analysis_chunks WHERE analysis_id=? AND reviewed=0${scope} ORDER BY sequence_number LIMIT 64`,[row.id,...(scoped?p.supportPending:[])]);
    if(!pending.length){p.phase=isContext?'support_reduce':'gather';await checkpoint(row.id,token,p);return;}
    const chunks=batchBySize(pending.map(r=>({...json(r.source_json),number:r.sequence_number,text:r.body})),p.reviewSize)[0];
    const value=await reviewProjectBatch(p.plan,chunks,isContext?[]:p.supportNotes);
    if(value.complete!==true){
      if(chunks.length>1){p.reviewSize=Math.max(1000,Math.floor(p.reviewSize/2));await checkpoint(row.id,token,p);return;}
      const c=chunks[0];if(c.text.length<=1000)throw new Error('Incomplete single passage');
      const middle=Math.floor(c.text.length/2),next=p.total+1,{text,...meta}=c;p.total++;
      if(isContext)p.supportPending.push(next);
      await checkpoint(row.id,token,p,async sql=>{
        await sql.execute('UPDATE knowledge_analysis_chunks SET body=? WHERE analysis_id=? AND sequence_number=?',[text.slice(0,middle),row.id,c.number]);
        await sql.execute('INSERT INTO knowledge_analysis_chunks (analysis_id,sequence_number,source_json,body) VALUES (?,?,?,?)',[row.id,next,JSON.stringify({...meta,number:next}),text.slice(middle)]);
      });return;
    }
    const findings=validateFindings(value,[...chunks.map(c=>c.number),...(!isContext?p.supportNotes.flatMap(f=>f.source_numbers):[])]);
    if(isContext){findings.candidates=[];p.supportNotes.push(...findings.findings);p.supportPending=p.supportPending.filter(n=>!chunks.some(c=>c.number===n));}
    else {
      const evidenceIds=new Set(chunks.filter(c=>!['projeto','estrutura','contexto','tarefa'].includes(c.kind)).map(c=>c.number));
      if(findings.candidates.some(c=>!c.source_numbers.some(n=>evidenceIds.has(n))))throw new Error('Proposta sem evidência válida.');
    }
    const reviewed=[...chunks.map(c=>c.number),...(!isContext&&p.rawSupport?p.supportPending:[])];
    if(!isContext&&p.rawSupport)p.supportPending=[];
    p.completed+=reviewed.length;
    await checkpoint(row.id,token,p,async sql=>{
      await sql.execute(`UPDATE knowledge_analysis_chunks SET reviewed=1,findings_json=NULL WHERE analysis_id=? AND sequence_number IN (${reviewed.map(()=>'?').join(',')})`,[row.id,...reviewed]);
      await sql.execute('UPDATE knowledge_analysis_chunks SET findings_json=? WHERE analysis_id=? AND sequence_number=?',[JSON.stringify(findings),row.id,chunks[0].number]);
    });return;
  }
  if(p.phase==='gather') {
    const [rows]=await db().execute('SELECT findings_json FROM knowledge_analysis_chunks WHERE analysis_id=? AND findings_json IS NOT NULL ORDER BY sequence_number',[row.id]);
    const values=rows.map(r=>json(r.findings_json));
    p.findings=values.flatMap(v=>v.findings);p.candidates=uniqueCandidates(values.flatMap(v=>v.candidates));p.matches=[];p.compareIndex=0;
    p.candidateBatches=batchBySize(p.candidates,6000).map(b=>b.map(c=>c.id));
    p.taskBatches=batchBySize(p.tasks.tasks,14000).map(b=>b.map(t=>t.id));
    p.compareTotal=p.plan.tasks==='compare'&&p.tasks.available?p.candidateBatches.length*p.taskBatches.length:0;
    p.phase=p.compareTotal?'compare':'reduce';
    await checkpoint(row.id,token,p);return;
  }
  if(p.phase==='compare') {
    const candidateIds=p.candidateBatches[Math.floor(p.compareIndex/p.taskBatches.length)],taskIds=p.taskBatches[p.compareIndex%p.taskBatches.length];
    const candidates=p.candidates.filter(c=>candidateIds.includes(c.id)),tasks=p.tasks.tasks.filter(t=>taskIds.includes(t.id));
    p.matches.push(...validateMatches(await compareProjectTasks(candidates,tasks),candidates,tasks));p.compareIndex++;
    if(p.compareIndex===p.compareTotal)p.phase='reduce';
    await checkpoint(row.id,token,p);return;
  }
  if(p.phase==='reduce'||p.phase==='support_reduce') {
    const support=p.phase==='support_reduce',key=support?'supportNotes':'findings';
    if(JSON.stringify(p[key]).length<=(support?48000:22000)){p.phase=support?'review':'answer';await checkpoint(row.id,token,p);return;}
    if(!p.reduction){p.reduction={batches:batchBySize(p[key],16000),notes:[],index:0,before:JSON.stringify(p[key]).length};}
    const r=p.reduction,input=r.batches[r.index],output=await reduceProjectFindings(support?{...p.plan,objective:'Preserve as relações, definições e orientações do contexto e da estrutura para interpretar as sínteses. '+p.plan.objective}:p.plan,input);
    const checked=validateFindings({complete:true,findings:output.findings,candidates:[]},input.flatMap(f=>f.source_numbers));
    if(!checked.findings.length)throw new Error('Reduction discarded findings');
    r.notes.push(...checked.findings);r.index++;
    if(r.index===r.batches.length){
      if(JSON.stringify(r.notes).length>=r.before)throw new Error('Reduction did not converge');
      p[key]=r.notes;delete p.reduction;
    }
    await checkpoint(row.id,token,p);return;
  }
  if(p.phase==='answer') {
    if(p.completed!==p.total)throw new Error('Incomplete coverage');
    const sources=await sourcesFor(row.id);
    const comparisons=p.plan.tasks==='none'?[]:finishComparisons(p.candidates,p.matches,p.tasks.tasks,p.plan.tasks==='compare'&&p.tasks.available&&p.compareIndex===p.compareTotal);
    const coverage={...p.coverage,chunks_read:p.completed,chunks_total:p.total,comparison_requested:p.plan.tasks==='compare',comparison_complete:p.plan.tasks==='compare'&&p.tasks.available&&p.compareIndex===p.compareTotal};
    const evidence=p.findings.map(f=>({number:f.source_numbers[0],source_numbers:f.source_numbers,kind:'nota',title:'Notas da leitura do projeto',text:f.text}));
    const generated=evidence.length?await answerKnowledgeQuestion(row.question,evidence,history,coverage):{blocks:[]};
    const blocks=evidence.length?validateKnowledgeBlocks(generated,sources):[];
    const cited=new Set([...blocks.flatMap(b=>b.source_numbers),...comparisons.flatMap(c=>c.source_numbers)]);
    const warnings=[];
    if(p.coverage.issues.length)warnings.push('Há conteúdo pendente ou sem leitura confirmada. Confira a cobertura abaixo.');
    if((p.plan.needs_tasks||p.plan.tasks==='compare')&&!p.tasks.available)warnings.push(p.coverage.task_message||'A lista da sala não pôde ser consultada. A resposta não confirma as tarefas existentes.');
    if(comparisons.length)warnings.push('Propostas semelhantes podem precisar de consolidação. Confira datas e evidências antes de criar ou atualizar tarefas.');
    const result={status:'answered',blocks,paragraphs:[],sources:sources.filter(s=>cited.has(s.number)),warnings,coverage,comparisons,task_mode:p.plan.tasks,...(!blocks.length?{message:'A leitura terminou sem evidência suficiente para responder a esse pedido. Confira as pendências de organização e, se necessário, inclua os documentos originais em uma nova consulta.'}:{})};
    // Completed jobs retain evidence in the chunk table, not duplicate model working buffers.
    await checkpoint(row.id,token,{phase:'complete',coverage,completed:p.completed,total:p.total,compareIndex:p.compareIndex,compareTotal:p.compareTotal},async()=>{},result);
  }
}
async function advance(row,token,session) {
  const started=Date.now(),phase=json(row.progress_json).phase;
  active.add(row.id);
  const heartbeat=setInterval(()=>{db().execute('UPDATE knowledge_analyses SET lease_until=? WHERE id=? AND state=? AND lease_token=?',[leaseEnd(),row.id,'working',token]).catch(()=>{});},30000);
  heartbeat.unref();
  try{await performStep(row,token,session);console.info('project_analysis_step:',phase,'duration_ms',Date.now()-started);}catch(error){
    // Provider responses may contain private text: log categories only.
    const validationCodes={'Evidência inválida na análise.':'INVALID_EVIDENCE','Proposta sem evidência válida.':'INVALID_CANDIDATE','Etapa muito extensa. Reduza o lote e retome.':'OVERSIZED_OUTPUT','Reduction discarded findings':'EMPTY_REDUCTION','Reduction did not converge':'REDUCTION_NOT_SMALLER','Invalid analysis plan':'INVALID_PLAN','Incomplete coverage':'INCOMPLETE_COVERAGE','Incomplete single passage':'INCOMPLETE_PASSAGE'};
    const category=/^[A-Z_0-9]+$/.test(error.code||'')?error.code:validationCodes[error.message]|| (error.name==='TimeoutError'?'PROVIDER_TIMEOUT':/Falha na análise/.test(error.message)?'PROVIDER_ERROR':/IA.*(JSON|interrompeu|concluiu)/.test(error.message)?'PROVIDER_INCOMPLETE':'VALIDATION_OR_STEP_ERROR');
    const frame=String(error.stack||'').match(/\/(?:server)\/([a-z-]+\.mjs):([0-9]+):[0-9]+/);
    console.warn('project_analysis_paused:',phase,category,'duration_ms',Date.now()-started,...(frame?['location',`${frame[1]}:${frame[2]}`]:[]));
    const p=json(row.progress_json);p.error=category==='DIRECT_ANSWER_INCOMPLETE'?'A IA não concluiu a resposta nesta tentativa. Você pode retomar; a leitura em etapas não foi iniciada.':'Esta etapa não foi concluída. O progresso anterior foi salvo; tente retomar.';
    await db().execute('UPDATE knowledge_analyses SET state=?,progress_json=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state=? AND lease_token=?',['paused',JSON.stringify(p),now(),row.id,'working',token]).catch(()=>{});
  }finally{clearInterval(heartbeat);active.delete(row.id);}
}
export function registerAnalysisRoutes(app,requireUser,membership,run,readCookie) {
  const guard=[requireUser,membership];
  const owned=async req=>{const [[row]]=await db().execute('SELECT * FROM knowledge_analyses WHERE id=? AND project_id=? AND user_id=?',[req.params.analysisId,req.params.projectId,req.user.id]);return row;};
  app.get(`${apiPath}/latest`,...guard,run(async(req,res)=>{
    const [[row]]=await db().execute("SELECT * FROM knowledge_analyses WHERE project_id=? AND user_id=? AND state<>'cancelled' ORDER BY created_at DESC,id DESC LIMIT 1",[req.params.projectId,req.user.id]);res.json({analysis:row?publicAnalysis(row):null});
  }));
  app.post(apiPath,...guard,run(async(req,res)=>{
    const {id,question}=req.body;
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)||typeof question!=='string'||question.trim().length<3||question.length>4000)return res.status(400).json({error:'Escreva uma instrução entre 3 e 4.000 caracteres.'});
    let history;try{history=validateConversation(req.body.history);}catch{return res.status(400).json({error:'Inicie uma nova conversa para continuar.'});}
    if(!process.env.OPENAI_API_KEY&&!process.env.OPENROUTER_API_KEY)return res.status(503).json({error:'A IA não está configurada neste ambiente.'});
    const sql=await db().getConnection();
    try{
      await sql.beginTransaction();await sql.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[req.user.id]);
      const [[old]]=await sql.execute('SELECT * FROM knowledge_analyses WHERE id=?',[id]);
      if(old){await sql.rollback();if(old.user_id!==req.user.id||old.project_id!==req.params.projectId)return res.status(409).json({error:'Identificador indisponível.'});return res.json(publicAnalysis(old));}
      const [[pending]]=await sql.execute("SELECT id FROM knowledge_analyses WHERE user_id=? AND project_id=? AND state IN ('ready','working','paused') LIMIT 1",[req.user.id,req.params.projectId]);
      if(pending){await sql.rollback();return res.status(409).json({error:'Retome ou encerre sua análise anterior antes de iniciar outra.'});}
      const stamp=now();
      await sql.execute('INSERT INTO knowledge_analyses (id,project_id,user_id,state,question,history_json,options_json,progress_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',[id,req.params.projectId,req.user.id,'ready',question.trim(),JSON.stringify(history),JSON.stringify({originals:req.body.originals===true}),JSON.stringify({version:2,phase:'plan'}),stamp,stamp]);
      await sql.commit();res.status(201).json({id,question:question.trim(),state:'ready',progress:{phase:'plan',completed:0,total:0},result:null});
    }catch(error){await sql.rollback();throw error;}finally{sql.release();}
  }));
  app.get(`${apiPath}/:analysisId`,...guard,run(async(req,res)=>{const row=await owned(req);if(!row)return res.status(404).json({error:'Análise não encontrada.'});res.json(publicAnalysis(row));}));
  app.post(`${apiPath}/:analysisId/advance`,...guard,run(async(req,res)=>{
    const row=await owned(req);if(!row)return res.status(404).json({error:'Análise não encontrada.'});
    if(['complete','cancelled'].includes(row.state))return res.json(publicAnalysis(row));
    if(active.has(row.id)||active.size>=3)return res.status(202).json(publicAnalysis(row));
    const token=randomUUID();
    const [claim]=await db().execute("UPDATE knowledge_analyses SET state='working',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND (state IN ('ready','paused') OR (state='working' AND lease_until<?))",[token,leaseEnd(),now(),row.id,now()]);
    if(claim.affectedRows)void advance(row,token,readCookie(req,'organizador_session'));
    res.status(202).json({...publicAnalysis(row),state:claim.affectedRows?'working':publicAnalysis(row).state});
  }));
  app.post(`${apiPath}/:analysisId/cancel`,...guard,run(async(req,res)=>{
    const row=await owned(req);if(!row)return res.status(404).json({error:'Análise não encontrada.'});
    await db().execute("UPDATE knowledge_analyses SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state<>'complete'",[now(),row.id]);res.json({ok:true});
  }));
}
