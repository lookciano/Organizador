import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';
import { loadKnowledge, selectKnowledge, validateKnowledgeBlocks, validateConversation } from './knowledge.mjs';
import { planKnowledgeQuestion, answerKnowledgeQuestion } from './ai.mjs';

const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const validDate = (value) => {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const statuses = new Set(['pendente', 'em_andamento', 'bloqueado', 'concluido']);
const now = () => new Date().toISOString();
const activeQuestions = new Set();

export function registerSecondBrainRoutes(app, requireUser, membership, run) {
  const guard = [requireUser, membership];
  app.post('/api/projects/:projectId/knowledge/ask', ...guard, run(async (req,res) => {
    const question = req.body.question;
    if(typeof question !== 'string' || question.trim().length < 3 || question.length > 4000) return res.status(400).json({error:'Escreva uma instrução entre 3 e 4.000 caracteres.'});
    let history;
    try {history=validateConversation(req.body.history);} catch {return res.status(400).json({error:'A conversa excede o limite. Inicie uma nova conversa.'});}
    if(activeQuestions.has(req.user.id) || activeQuestions.size >= 3) return res.status(429).json({error:'Há uma consulta em andamento. Aguarde um momento e tente novamente.'});
    activeQuestions.add(req.user.id);
    try {
      const {documents,warnings} = await loadKnowledge(req.params.projectId);
      const hasAI = Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
      let plan = {};
      const retrievalQuestion=[...history.map(t=>t.question),question].join(' ');
      if(hasAI) try {plan=await planKnowledgeQuestion(question.trim(),history);} catch { warnings.push('A interpretação da pergunta ficou indisponível; a seleção usou as palavras da sua pergunta.'); }
      const {sources,omitted} = selectKnowledge(documents,retrievalQuestion,plan);
      if(omitted) warnings.push('A resposta usa uma seleção dos trechos mais relevantes. Consulte as fontes e refine a pergunta para aprofundar.');
      if(!sources.length) return res.json({status:'no_evidence',paragraphs:[],sources:[],warnings,message:'Não encontrei evidências suficientes para essa pergunta nos textos consultados. Tente indicar o equipamento, local ou fornecedor.'});
      let blocks = [];
      if(hasAI) try {blocks=validateKnowledgeBlocks(await answerKnowledgeQuestion(question.trim(),sources,history),sources);} catch { warnings.push('Não foi possível gerar uma resposta com referências válidas agora. Os trechos encontrados estão disponíveis abaixo; tente novamente.'); }
      else warnings.push('A IA não está configurada neste ambiente. Exibindo somente os trechos encontrados.');
      res.json({status:blocks.length?'answered':'unavailable',blocks,paragraphs:[],sources,warnings});
    } finally { activeQuestions.delete(req.user.id); }
  }));
  app.get('/api/projects/:projectId/knowledge/search', ...guard, run(async (req, res) => {
    const q = clean(req.query.q, 150);
    if (q.length < 2) return res.status(400).json({ error: 'Informe pelo menos dois caracteres' });
    const projectId = req.params.projectId;
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    const [items, updates, sources, context] = await Promise.all([
      db().execute("SELECT id,title,summary,status,responsible,due_date,updated_at FROM items WHERE project_id=? AND (title LIKE ? OR summary LIKE ? OR responsible LIKE ? OR supplier LIKE ?) ORDER BY updated_at DESC LIMIT 35", [projectId,like,like,like,like]),
      db().execute("SELECT u.id,u.item_id,u.summary,u.evidence,u.created_at FROM item_updates u JOIN items i ON i.id=u.item_id WHERE i.project_id=? AND (u.summary LIKE ? OR u.evidence LIKE ?) ORDER BY u.created_at DESC LIMIT 25", [projectId,like,like]),
      db().execute("SELECT id,title,LEFT(body,1000) AS excerpt,created_at FROM sources WHERE project_id=? AND (title LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT 20", [projectId,like,like]),
      db().execute("SELECT id,title,LEFT(extracted_text,1000) AS excerpt,created_at FROM project_context_entries WHERE project_id=? AND archived=0 AND (title LIKE ? OR extracted_text LIKE ?) ORDER BY created_at DESC LIMIT 20", [projectId,like,like]),
    ]);
    res.json({ query:q, results:[
      ...items[0].map(x=>({kind:'assunto',...x})),
      ...updates[0].map(x=>({kind:'historico',...x})),
      ...sources[0].map(x=>({kind:'fonte',...x})),
      ...context[0].map(x=>({kind:'contexto',...x}))
    ] });
  }));

  app.get('/api/projects/:projectId/tasks', ...guard, run(async (req,res)=>{
    const [rows] = await db().execute('SELECT * FROM second_brain_tasks WHERE project_id=? ORDER BY CASE WHEN status="concluido" THEN 1 ELSE 0 END,due_date ASC,created_at DESC LIMIT 500', [req.params.projectId]);
    res.json({tasks:rows});
  }));
  app.post('/api/projects/:projectId/tasks', ...guard, run(async (req,res)=>{
    const title=clean(req.body.title,255), dueDate=req.body.due_date ?? '';
    const status=clean(req.body.status,30)||'pendente';
    const itemId=clean(req.body.item_id,36)||null;
    if(!title || !validDate(dueDate) || !statuses.has(status)) return res.status(400).json({error:'Dados da tarefa inválidos'});
    if(itemId){
      const [existing]=await db().execute('SELECT id FROM items WHERE id=? AND project_id=?',[itemId,req.params.projectId]);
      if(!existing.length) return res.status(400).json({error:'Assunto não pertence ao projeto'});
    }
    const id=randomUUID(), timestamp=now();
    await db().execute('INSERT INTO second_brain_tasks (id,project_id,item_id,title,description,responsible,due_date,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id,req.params.projectId,itemId,title,clean(req.body.description,4000),clean(req.body.responsible,160),dueDate,status,req.user.id,timestamp,timestamp]);
    res.status(201).json({id});
  }));
  app.patch('/api/projects/:projectId/tasks/:taskId', ...guard, run(async (req,res)=>{
    const [rows]=await db().execute('SELECT * FROM second_brain_tasks WHERE id=? AND project_id=?',[req.params.taskId,req.params.projectId]);
    if(!rows.length) return res.status(404).json({error:'Tarefa não encontrada'});
    const old=rows[0], title=req.body.title===undefined?old.title:clean(req.body.title,255);
    const dueDate=req.body.due_date===undefined?old.due_date:req.body.due_date;
    const status=req.body.status===undefined?old.status:clean(req.body.status,30);
    if(!title || !validDate(dueDate) || !statuses.has(status)) return res.status(400).json({error:'Dados inválidos'});
    await db().execute('UPDATE second_brain_tasks SET title=?,description=?,responsible=?,due_date=?,status=?,updated_at=? WHERE id=? AND project_id=?',
      [title,req.body.description===undefined?old.description:clean(req.body.description,4000),req.body.responsible===undefined?old.responsible:clean(req.body.responsible,160),dueDate,status,now(),old.id,req.params.projectId]);
    res.json({ok:true});
  }));
}
