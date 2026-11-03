import { createHash } from 'node:crypto';
import { extractFileText } from './file-text.mjs';
import { normalizeKnowledge, validateKnowledgeBlocks } from './knowledge.mjs';

const text = value => String(value ?? '');
const stamp = () => new Date().toISOString();
export async function readAllPages(database, sql, projectId, key = 'id', pageSize = 200) {
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>10000)throw new Error('Invalid page size');
  const pageSql=sql.replace(/LIMIT \?$/,`LIMIT ${pageSize}`);
  const all=[];let cursor='';
  for(;;) {
    const [rows]=await database.execute(pageSql,[projectId,cursor]);
    if(!rows.length)break;
    all.push(...rows);const next=text(rows.at(-1)[key]);
    if(next<=cursor)throw new Error('A leitura do projeto não avançou.');
    cursor=next;if(rows.length<pageSize)break;
  }
  return all;
}
export function topicPaths(nodes) {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  return new Map(nodes.map(node=>{
    const titles=[node.title],seen=new Set([node.id]);let parent=byId.get(node.parent_id);
    while(parent && !seen.has(parent.id)){seen.add(parent.id);titles.unshift(parent.title);parent=byId.get(parent.parent_id);}
    return [node.id,titles.join(' › ')];
  }));
}
// The transaction is used only for the database snapshot, never held during LLM calls.
export async function loadProjectCorpus(projectId, database, {originals=false, history=false} = {}) {
  const docs=[],issues=[],counts={};
  const add=(kind,row,body,extra={})=>{
    counts[kind]=(counts[kind]||0)+1;
    docs.push({kind,id:text(row.id ?? row.node_id),title:row.title || kind,created_at:row.updated_at || row.generated_at || row.created_at || '',text:text(body),...extra});
  };
  const [[project]]=await database.execute('SELECT id,name,description,created_at FROM projects WHERE id=?',[projectId]);
  if(!project)throw new Error('Projeto indisponível.');
  add('projeto',{...project,title:project.name},project.description || 'Projeto sem descrição adicional.');
  const nodes=await readAllPages(database,'SELECT id,parent_id,title,sort_order,archived,created_at FROM structure_nodes WHERE project_id=? AND id>? ORDER BY id LIMIT ?',projectId);
  const paths=topicPaths(nodes);
  const activeNodes=nodes.filter(n=>!n.archived);
  if(activeNodes.length)add('estrutura',{id:projectId,title:'Estrutura atual do projeto'},activeNodes.map(n=>paths.get(n.id)).join('\n'));
  counts.estrutura=activeNodes.length;
  const context=await readAllPages(database,'SELECT id,title,body,extracted_text,archived,file_name,OCTET_LENGTH(file_data) AS file_bytes,created_at FROM project_context_entries WHERE project_id=? AND archived=0 AND id>? ORDER BY id LIMIT ?',projectId);
  for(const row of context){
    add('contexto',row,`Situação: ${row.archived?'contexto arquivado, não é orientação atual':'contexto ativo'}\n${[row.body,row.extracted_text].filter(Boolean).join('\n\n')}`);
    if(row.file_bytes && !text(row.extracted_text).trim())issues.push({kind:'contexto',id:row.id,title:row.title,message:'Anexo de contexto sem texto extraído disponível.'});
  }
  for(const [table,kind] of [['topic_summaries','sintese'],['topic_executive_summaries','resumo']]) {
    const rows=await readAllPages(database,`SELECT s.node_id,s.summary,${kind==='sintese'?'s.important_change,':''}s.analysis_status,s.generated_at,n.title,n.archived FROM ${table} s JOIN structure_nodes n ON n.id=s.node_id AND n.project_id=s.project_id WHERE s.project_id=? AND n.archived=0 AND s.node_id>? ORDER BY s.node_id LIMIT ?`,projectId,'node_id');
    for(const row of rows){
      if(text(row.summary).trim())add(kind,{...row,title:paths.get(row.node_id)||row.title},`Tópico ${row.archived?'arquivado, conteúdo histórico':'ativo'}\n${row.summary}${row.important_change?'\nMudança relevante: '+row.important_change:''}`,{node_id:row.node_id});
      if(row.analysis_status!=='completed' || !text(row.summary).trim())issues.push({kind,id:row.node_id,title:paths.get(row.node_id)||row.title,message:row.summary?'Última versão salva; atualização ainda não concluída.':'Síntese ou resumo ainda sem conteúdo gerado.'});
    }
  }
  if(history){
    const items=await readAllPages(database,'SELECT id,node_id,title,summary,location,discipline,supplier,responsible,status,due_date,attention,latest_source_id,updated_at FROM items WHERE project_id=? AND id>? ORDER BY id LIMIT ?',projectId);
    const itemMap=new Map(items.map(i=>[i.id,i]));
    for(const row of items)add('assunto',row,`Tópico: ${paths.get(row.node_id)||'Sem tópico confirmado'}\nEstado atual: ${row.summary}\nLocal: ${row.location}\nDisciplina: ${row.discipline}\nFornecedor: ${row.supplier}\nResponsável: ${row.responsible||'não informado'}\nStatus: ${row.status}\nPrazo registrado: ${row.due_date||'não informado'}\nPonto de atenção: ${row.attention?'sim':'não'}`,{item_id:row.id,node_id:row.node_id});
    const updates=await readAllPages(database,'SELECT u.id,u.item_id,u.source_id,u.summary,u.evidence,u.previous_status,u.new_status,u.created_at FROM item_updates u JOIN items i ON i.id=u.item_id WHERE i.project_id=? AND u.id>? ORDER BY u.id LIMIT ?',projectId);
    for(const row of updates){const item=itemMap.get(row.item_id);add('historico',{...row,title:`Histórico — ${item?.title||'Assunto'}`},`Tópico: ${paths.get(item?.node_id)||'Sem tópico confirmado'}\nLocal: ${item?.location||''}\nRegistro histórico: ${row.summary}\nEvidência: ${row.evidence}\nStatus anterior: ${row.previous_status||''}\nStatus na atualização: ${row.new_status}`,{item_id:row.item_id,node_id:item?.node_id});}
  }
  // Read only source status metadata unless the user requested original documents.
  const sources=await readAllPages(database,`SELECT id,title,${originals?'body,content_type,file_name,OCTET_LENGTH(file_data) AS file_bytes,':''}analysis_status,created_at FROM sources WHERE project_id=? AND id>? ORDER BY id LIMIT ?`,projectId);
  for(const row of sources){
    if(row.analysis_status!=='completed')issues.push({kind:'fonte',id:row.id,title:row.title,message:'Documento ainda não processado; suas informações podem não estar no Relatório vivo.'});
    if(originals){
      let extracted='';
      if(row.file_bytes){
        const [[file]]=await database.execute('SELECT file_data FROM sources WHERE project_id=? AND id=?',[projectId,row.id]);
        try{extracted=await extractFileText(file?.file_data,row.content_type);}catch{issues.push({kind:'fonte',id:row.id,title:row.title,message:'Não foi possível extrair integralmente o anexo; ele não foi contado como lido.'});}
        if(!extracted)issues.push({kind:'fonte',id:row.id,title:row.title,message:'Anexo sem texto legível disponível. Imagens digitalizadas precisam de transcrição.'});
      }
      add('fonte',row,[row.body,extracted].filter(Boolean).join('\n\n'));
    }
  }
  const [itemDates]=await database.execute('SELECT node_id,MAX(updated_at) AS latest_update FROM items WHERE project_id=? GROUP BY node_id',[projectId]);
  const byNode=new Map(nodes.map(n=>[n.id,n])),latest=new Map();
  for(const item of itemDates){let id=item.node_id;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);if(!latest.has(id)||latest.get(id)<item.latest_update)latest.set(id,item.latest_update);id=byNode.get(id)?.parent_id;}}
  for(const d of docs.filter(d=>['sintese','resumo'].includes(d.kind)))if(latest.get(d.node_id)>d.created_at)issues.push({kind:d.kind,id:d.id,title:d.title,message:'Há registros atualizados após esta síntese ou resumo; a resposta usa a versão salva.'});
  for(const n of activeNodes.filter(n=>!n.parent_id&&latest.has(n.id)))if(!docs.some(d=>d.kind==='sintese'&&d.node_id===n.id))issues.push({kind:'sintese',id:n.id,title:n.title,message:'Este tópico tem registros, mas ainda não possui síntese salva.'});
  if(!counts.sintese&&!counts.resumo)issues.push({kind:'relatorio',id:projectId,title:project.name,message:'Não há sínteses ou resumos ativos disponíveis. Gere o Relatório vivo para fundamentar a resposta.'});
  return {documents:docs,coverage:{snapshot_at:stamp(),scope:'living_report',history_included:history,counts,original_documents:sources.length,originals_included:originals,issues,document_count:docs.length}};
}

export function makeChunks(documents, maxChars=5000) {
  const chunks=[];
  for(const doc of documents){
    const body=doc.text||'Registro sem conteúdo textual adicional.';
    for(let start=0,part=1;start<body.length;start+=maxChars,part++){
      const {text:unused,...meta}=doc;
      chunks.push({...meta,text:body.slice(start,start+maxChars),part,number:chunks.length+1});
    }
  }
  return chunks;
}
// Monta o lote da revisão mantendo cada documento inteiro dentro do mesmo lote.
// Sem isso, um trecho originado de divisão (parte 2 de uma síntese, por exemplo)
// cai no fim da fila e a IA lê o registro pela metade, interpretando o contexto errado.
export function groupBatchByDocument(chunks, maxChars = 32000) {
  const measure = (chunk) => JSON.stringify(chunk).length;
  const groups = new Map();
  for (const chunk of chunks) {
    const key = `${chunk.kind || ''}|${chunk.id || chunk.number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chunk);
  }
  const batch = [];
  let size = 0;
  for (const group of groups.values()) {
    const total = group.reduce((sum, chunk) => sum + measure(chunk), 0);
    if (batch.length && size + total > maxChars) break;
    for (const chunk of group) {
      const cost = measure(chunk);
      if (batch.length && size + cost > maxChars) return batch;
      batch.push(chunk); size += cost;
    }
  }
  return batch;
}

export function batchBySize(values, maxChars=16000, measure=value=>JSON.stringify(value).length) {
  const batches=[];let batch=[],size=0;
  for(const value of values){const n=measure(value);if(batch.length && size+n>maxChars){batches.push(batch);batch=[];size=0;}batch.push(value);size+=n;}
  if(batch.length)batches.push(batch);return batches;
}
export function validateFindings(result, allowed) {
  if(result?.complete!==true)throw new Error('A etapa não confirmou leitura integral. Reduza o lote e retome.');
  const numbers=new Set(allowed);
  const refs=value=>Array.isArray(value)&&value.length>0&&value.every(n=>Number.isInteger(n)&&numbers.has(n));
  const validText=(v,max)=>typeof v==='string'&&v.length<=max;
  if(!Array.isArray(result.findings)||!Array.isArray(result.candidates))throw new Error('Análise sem estrutura válida.');
  for(const f of result.findings)if(!validText(f.text,5000)||!f.text.trim()||!refs(f.source_numbers))throw new Error('Evidência inválida na análise.');
  for(const c of result.candidates)if(!['action','location','equipment','responsible','due_date'].every(k=>validText(c[k],k==='action'?2500:300))||!c.action.trim()||!refs(c.source_numbers))throw new Error('Proposta sem evidência válida.');
  if(JSON.stringify(result).length>60000)throw new Error('Etapa muito extensa. Reduza o lote e retome.');
  return result;
}
export function uniqueCandidates(candidates) {
  const map=new Map();
  for(const c of candidates){
    const key=['action','location','equipment','responsible','due_date'].map(k=>normalizeKnowledge(c[k])).join('|');
    if(map.has(key))map.get(key).source_numbers=[...new Set([...map.get(key).source_numbers,...c.source_numbers])];
    else map.set(key,{...c,source_numbers:[...new Set(c.source_numbers)]});
  }
  return [...map.values()].map((c,i)=>({...c,id:i+1}));
}
export function validateMatches(result, candidates, tasks) {
  const ids=new Set(candidates.map(c=>c.id)),taskIds=new Set(tasks.map(t=>t.id));
  if(!Array.isArray(result?.comparisons)||result.comparisons.length!==ids.size)throw new Error('Comparação incompleta.');
  const seen=new Set();
  for(const row of result.comparisons){
    if(!ids.has(row.candidate_id)||seen.has(row.candidate_id)||!Array.isArray(row.matches))throw new Error('Comparação duplicada ou inválida.');seen.add(row.candidate_id);
    for(const m of row.matches)if(!taskIds.has(m.task_id)||!['existing','update','review'].includes(m.relation)||typeof m.reason!=='string'||!m.reason.trim()||m.reason.length>1500)throw new Error('Correspondência sem tarefa válida.');
  }
  return result.comparisons;
}
export function finishComparisons(candidates, matches, tasks, complete) {
  const byId=new Map(tasks.map(t=>[t.id,t]));
  return candidates.map(c=>{
    const related=matches.filter(m=>m.candidate_id===c.id).flatMap(m=>m.matches).map(m=>({...m,task:byId.get(m.task_id)}));
    const dedup=[...new Map(related.map(m=>[`${m.task_id}:${m.relation}`,m])).values()];
    let classification='possible_new';
    if(!complete)classification='not_compared';
    else if(dedup.some(m=>m.relation==='review'||m.task?.status==='completed'))classification='review';
    else if(dedup.some(m=>m.relation==='update'))classification='update';
    else if(dedup.length)classification='existing';
    return {...c,classification,matches:dedup};
  });
}
export function taskDocuments(snapshot) {
  return snapshot.tasks.map(t=>({kind:'tarefa',id:String(t.id),title:`Tarefa ${t.taskNumber||t.id} — ${snapshot.room.name}`,created_at:t.updatedAt||snapshot.read_at,text:`Descrição: ${t.description}\nResponsável: ${t.assignedToName||'não informado'}\nPrazo: ${t.dueDate||'não informado'}\nSituação: ${t.status}\nPrioridade: ${t.priority||'não informada'}`}));
}
export function revisionOf(chunks) {
  const hash=createHash('sha256');for(const c of chunks)hash.update(JSON.stringify(c));return hash.digest('hex');
}
export { validateKnowledgeBlocks };
