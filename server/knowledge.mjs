import { db } from './db.mjs';
import { extractFileText } from './file-text.mjs';

export const normalizeKnowledge = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stopwords = new Set('me fala fale diga conte tudo todos todas sobre como qual quais quando onde porque quero saber gostaria poderia voce voces uma umas uns dos das para com que esse essa isso este esta pelo pela nos nas por tem foi sao esta estao assunto informacao informacoes projeto'.split(' '));
export function knowledgeTerms(question) {
  return [...new Set(normalizeKnowledge(question).split(' ').filter(t => t.length >= 3 && !stopwords.has(t)))].slice(0, 20);
}
const stem = token => token.length > 4 ? token.replace(/s$/, '') : token;
const wordSet = text => new Set(normalizeKnowledge(text).split(' ').map(stem));
const matches = (words, parts) => parts.length && parts.every(part => words.has(part));

// Bounded, overlapping passages retain matches deep inside uploaded documents.
export function rankKnowledge(documents, question, expandedTerms = [], maxChars = 42000) {
  const original = knowledgeTerms(question);
  const expanded = [...new Set(expandedTerms.filter(t => typeof t === 'string' && t.length <= 80).map(normalizeKnowledge))].filter(Boolean).slice(0, 10);
  const originalParts = original.map(t=>[stem(t)]);
  const expandedParts = expanded.map(t=>t.split(' ').map(stem));
  const candidates = [];
  for (const document of documents) {
    const body = String(document.text || '');
    for (let start = 0; start < body.length; start += 1800) {
      const text = body.slice(start, start + 2200);
      const searchable = wordSet(`${document.title} ${text}`);
      const titleWords = wordSet(document.title);
      const originalMatches = originalParts.filter(term => matches(searchable, term)).length;
      const extraMatches = expandedParts.filter(term => matches(searchable, term)).length;
      if (!originalMatches && !extraMatches) continue;
      const coverage = original.length ? originalMatches / original.length : 0;
      const score = coverage * 30 + originalMatches * 3 + extraMatches * 2 + originalParts.filter(term => matches(titleWords, term)).length;
      candidates.push({ ...document, text, part: Math.floor(start / 1800) + 1, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id) || a.part - b.part);
  const selected = [], perDocument = new Map(); let used = 0;
  for (const candidate of candidates) {
    if (candidate.score < (candidates[0]?.score || 0) * 0.45) continue;
    const key = `${candidate.kind}:${candidate.id}`;
    if ((perDocument.get(key) || 0) >= 3 || used + candidate.text.length > maxChars) continue;
    perDocument.set(key, (perDocument.get(key) || 0) + 1);
    const {score, ...source} = candidate;
    selected.push({...source, number:selected.length + 1}); used += source.text.length;
    if (selected.length >= 24) break;
  }
  return {sources:selected, omitted:candidates.length > selected.length};
}

// All reads are scoped to the authenticated project. No credentials or binary files go to the LLM.
export async function loadKnowledge(projectId, database = db()) {
  const warnings = [];
  const limits = [1000,5000,200,200,300,300];
  const queries = [
    'SELECT id,title,summary,location,supplier,responsible,status,due_date,updated_at FROM items WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT 1001',
    'SELECT u.id,u.item_id,u.summary,u.evidence,u.created_at,i.title,i.location FROM item_updates u JOIN items i ON i.id=u.item_id WHERE i.project_id=? ORDER BY u.created_at DESC,u.id DESC LIMIT 5001',
    'SELECT id,title,body,content_type,OCTET_LENGTH(file_data) AS file_bytes,created_at FROM sources WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 201',
    'SELECT id,title,body,extracted_text,created_at FROM project_context_entries WHERE project_id=? AND archived=0 ORDER BY created_at DESC,id DESC LIMIT 201',
    'SELECT s.node_id,s.summary,s.important_change,s.generated_at,s.analysis_status,n.title,n.parent_id FROM topic_summaries s JOIN structure_nodes n ON n.id=s.node_id AND n.project_id=s.project_id WHERE s.project_id=? AND n.archived=0 AND s.summary<>\'\' ORDER BY n.parent_id IS NULL DESC,s.generated_at DESC,s.node_id LIMIT 301',
    'SELECT s.node_id,s.summary,s.generated_at,s.analysis_status,n.title,n.parent_id FROM topic_executive_summaries s JOIN structure_nodes n ON n.id=s.node_id AND n.project_id=s.project_id WHERE s.project_id=? AND n.archived=0 AND s.summary<>\'\' ORDER BY n.parent_id IS NULL DESC,s.generated_at DESC,s.node_id LIMIT 301',
  ];
  const results = await Promise.all(queries.map(sql => database.execute(sql,[projectId])));
  const sets = results.map(([rows],i) => { if(rows.length > limits[i]) warnings.push('O projeto excede o limite de leitura desta consulta; foram priorizados os registros mais recentes.'); return rows.slice(0,limits[i]); });
  const documents = []; let chars=0, files=0, bytes=0;
  const add = doc => {
    if(chars + doc.text.length > 4000000) {warnings.push('Parte do conteúdo ficou fora do limite de leitura desta consulta.');return;}
    chars += doc.text.length;documents.push(doc);
  };
  for(const [index,kind] of [[4,'sintese'],[5,'resumo']]) for(const row of sets[index]) {
    add({kind,id:row.node_id,node_id:row.node_id,parent_id:row.parent_id,title:row.title,created_at:row.generated_at,text:[row.summary,row.important_change && `Mudança relevante: ${row.important_change}`].filter(Boolean).join('\n\n')});
    if(row.analysis_status !== 'completed') warnings.push('Há sínteses ou resumos em atualização. A consulta utiliza a última versão salva e sua data de geração.');
  }
  for(const row of sets[0]) add({kind:'assunto',id:row.id,item_id:row.id,title:row.title,created_at:row.updated_at,text:`Estado atual registrado: ${row.summary}\nLocal: ${row.location}\nFornecedor: ${row.supplier}\nResponsável: ${row.responsible}\nStatus: ${row.status}\nPrazo registrado: ${row.due_date || 'não informado'}`});
  for(const row of sets[1]) add({kind:'historico',id:row.id,item_id:row.item_id,title:`Histórico — ${row.title}`,created_at:row.created_at,text:`Local do assunto: ${row.location}\nRegistro histórico: ${row.summary}\nEvidência: ${row.evidence}`});
  for(const row of sets[3]) add({kind:'contexto',id:row.id,title:row.title,created_at:row.created_at,text:[row.body,row.extracted_text].filter(Boolean).join('\n\n')});
  for(const row of sets[2]) {
    let extracted = '';
    if(row.file_bytes) {
      if(files >= 40 || bytes + Number(row.file_bytes) > 20000000 || chars >= 4000000) warnings.push('Alguns anexos não foram lidos nesta consulta por limite de volume.');
      else {
        files++;bytes+=Number(row.file_bytes);
        const [[file]] = await database.execute('SELECT file_data FROM sources WHERE project_id=? AND id=?',[projectId,row.id]);
        try { extracted = await extractFileText(file?.file_data,row.content_type); }
        catch { warnings.push('Não foi possível extrair o texto de um ou mais anexos; seus registros já analisados continuam disponíveis.'); }
        if(!extracted) warnings.push('Um ou mais anexos não possuem texto legível; imagens e PDFs digitalizados dependem dos registros previamente analisados.');
      }
    }
    add({kind:'fonte',id:row.id,title:row.title,created_at:row.created_at,text:[row.body,extracted].filter(Boolean).join('\n\n')});
  }
  return {documents,warnings:[...new Set(warnings)]};
}

export function validateKnowledgeAnswer(result, sources) {
  if (!Array.isArray(result?.paragraphs)) throw new Error('Invalid knowledge response');
  const numbers = new Set(sources.map(s=>s.number));
  const paragraphs = result.paragraphs.slice(0,16).map(p=>{
    if(typeof p.text !== 'string' || !p.text.trim() || p.text.length > 3000 || !Array.isArray(p.source_numbers) || !p.source_numbers.length || p.source_numbers.some(n=>!numbers.has(n))) throw new Error('Unsupported knowledge citation');
    return {text:p.text.trim(),source_numbers:[...new Set(p.source_numbers)]};
  });
  if(!paragraphs.length) throw new Error('Empty knowledge response');
  return paragraphs;
}

// A broad instruction (e.g. a task list from syntheses) need not match literal words.
// Round-robin passages favor topic coverage, and report every volume reduction.
export function selectKnowledge(documents, question, plan = {}) {
  const preferred = plan.source === 'syntheses' ? ['sintese'] : plan.source === 'executive' ? ['resumo'] : null;
  const corpus = preferred ? documents.filter(d=>preferred.includes(d.kind)) : documents;
  if(plan.scope !== 'project') return rankKnowledge(corpus, plan.search_terms?.length ? plan.search_terms.join(' ') : question, plan.search_terms || []);
  const ordered = [...corpus].sort((a,b)=> {
    const priority = d => (d.kind === 'sintese' || d.kind === 'resumo') ? (d.parent_id ? 1 : 0) : d.kind === 'assunto' ? 2 : 3;
    return priority(a)-priority(b) || String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id);
  });
  const sources=[];let used=0,total=0;
  for(const d of ordered) total += Math.ceil(String(d.text || '').length / 1800);
  for(let part=0; part<3; part++) for(const d of ordered) {
    const text=String(d.text || '').slice(part*1800,part*1800+2200);
    if(!text || sources.length>=24 || used+text.length>42000) continue;
    sources.push({...d,text,part:part+1,number:sources.length+1});used+=text.length;
  }
  return {sources,omitted:total>sources.length};
}

export function validateConversation(history = []) {
  if(!Array.isArray(history) || history.length>6) throw new Error('Invalid conversation');
  let length=0;
  return history.map(turn=>{
    if(typeof turn?.question !== 'string' || !turn.question.trim() || turn.question.length>4000 || typeof turn.answer !== 'string' || turn.answer.length>12000) throw new Error('Invalid conversation');
    length+=turn.question.length+turn.answer.length;
    if(length>40000) throw new Error('Conversation too long');
    return {question:turn.question,answer:turn.answer};
  });
}

export function validateKnowledgeBlocks(result, sources) {
  const fail=code=>{throw Object.assign(new Error('A resposta da IA não passou na validação.'),{code});};
  if(!Array.isArray(result?.blocks) || !result.blocks.length || result.blocks.length>24) fail('ANSWER_BLOCK_COUNT');
  const numbers=new Set(sources.map(s=>s.number));
  const string=(value,max)=>typeof value==='string' && value.length<=max;
  let chars=0;
  return result.blocks.map(b=>{
    if(!b || !['paragraph','list','table'].includes(b.type)) fail('ANSWER_BLOCK_TYPE');
    if(!string(b.title,200) || !string(b.text,4000)) fail('ANSWER_TEXT_SIZE');
    if(!Array.isArray(b.items) || b.items.length>30 || b.items.some(x=>!string(x,2000))) fail('ANSWER_LIST_SHAPE');
    if(!Array.isArray(b.columns) || b.columns.length>8 || b.columns.some(x=>!string(x,150))) fail('ANSWER_COLUMNS_SHAPE');
    if(!Array.isArray(b.rows) || b.rows.length>30 || b.rows.some(r=>!Array.isArray(r) || r.length!==b.columns.length || r.some(x=>!string(x,1500)))) fail('ANSWER_ROWS_SHAPE');
    if(!Array.isArray(b.source_numbers) || !b.source_numbers.length || b.source_numbers.some(n=>!numbers.has(n))) fail('ANSWER_CITATION');
    if(b.type==='paragraph' && !b.text.trim() || b.type==='list' && !b.items.length || b.type==='table' && (!b.columns.length || !b.rows.length)) fail('ANSWER_EMPTY_BLOCK');
    chars+=JSON.stringify(b).length;if(chars>32000) fail('ANSWER_TOTAL_SIZE');
    return {type:b.type,title:b.title,text:b.text,items:b.items,columns:b.columns,rows:b.rows,source_numbers:[...new Set(b.source_numbers)]};
  });
}
