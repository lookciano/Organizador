import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// This suite refuses cloud databases and uses only synthetic data in a NEW database.
const target = process.env.TEST_DATABASE_URL;
test('PR #1: TiDB migration, authorization and regression', { skip: !target, timeout: 120000 }, async t => {
  const url = new URL(target);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only a local disposable database is allowed');
  assert.match(url.pathname, /^\/pr1_validation_[a-z0-9_]+$/);
  assert.ok(process.env.NODE_EXTRA_CA_CERTS, 'A trusted test TLS certificate is required');
  const database = url.pathname.slice(1);
  const admin = await mysql.createConnection({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
  t.after(() => admin.end());
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.query(`USE \`${database}\``);
  const [[version]] = await admin.query('SELECT VERSION() AS version');
  t.diagnostic(`Engine: ${version.version}; TLS verification enabled; synthetic fixtures only`);
  const baseline = execFileSync('git', ['show', '17ce042768bd21c8adb55bbf114a4f9981de5b0f:server/db.mjs'], { encoding: 'utf8' });
  const statements = [...baseline.split('const schema = [')[1].split('\n];')[0].matchAll(/`([^`]+)`/g)].map(m => m[1]);
  assert.equal(statements.length, 17);
  for (const sql of statements) await admin.query(sql);
  const stamp = new Date().toISOString();
  const password = randomUUID();
  const passwordHash = await bcrypt.hash(password, 4);
  for (const user of ['owner-a', 'member-a', 'owner-b']) {
    await admin.execute('INSERT INTO users VALUES (?,?,?,?)', [user, `${user}@example.invalid`, passwordHash, stamp]);
  }
  for (const suffix of ['a', 'b']) {
    await admin.execute('INSERT INTO projects VALUES (?,?,?,?,?)', [`project-${suffix}`, `Projeto ${suffix}`, 'Synthetic', `owner-${suffix}`, stamp]);
    await admin.execute('INSERT INTO memberships VALUES (?,?,?,?)', [`project-${suffix}`, `owner-${suffix}`, 'owner', stamp]);
    await admin.execute('INSERT INTO items (id,project_id,title,summary,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [`item-${suffix}`, `project-${suffix}`, `Teste exclusivo ${suffix} 100% — Cubículo Ceará-Mirim`, `Evidência ${suffix}`, 'pendente', stamp, stamp]);
    await admin.execute('INSERT INTO item_updates (id,item_id,summary,evidence,new_status,created_at) VALUES (?,?,?,?,?,?)', [`update-${suffix}`, `item-${suffix}`, `Teste histórico ${suffix}`, `Evidência ${suffix}`, 'pendente', stamp]);
    await admin.execute('INSERT INTO sources (id,project_id,author_id,title,kind,body,analysis_status,created_at) VALUES (?,?,?,?,?,?,?,?)', [`source-${suffix}`, `project-${suffix}`, `owner-${suffix}`, `Teste fonte ${suffix}`, 'text', `Teste corpo ${suffix}`, 'done', stamp]);
    await admin.execute('INSERT INTO project_context_entries (id,project_id,author_id,title,body,extracted_text,archived,created_at) VALUES (?,?,?,?,?,?,?,?)', [`context-${suffix}`, `project-${suffix}`, `owner-${suffix}`, `Teste contexto ${suffix}`, 'Synthetic', `Teste contexto ${suffix}`, 0, stamp]);
  }
  await admin.execute('INSERT INTO memberships VALUES (?,?,?,?)', ['project-a', 'member-a', 'member', stamp]);
  await admin.execute('INSERT INTO project_context_entries (id,project_id,author_id,title,body,extracted_text,archived,created_at) VALUES (?,?,?,?,?,?,?,?)', ['context-archived', 'project-a', 'owner-a', 'Teste arquivado', 'Synthetic', 'Teste arquivado', 1, stamp]);
  const [beforeTables] = await admin.query('SHOW TABLES');
  const tableNames = beforeTables.map(row => Object.values(row)[0]);
  async function fingerprints() {
    const result = {};
    for (const table of tableNames) {
      const [rows] = await admin.query(`SELECT * FROM \`${table}\``);
      result[table] = createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');
    }
    return result;
  }
  const before = await fingerprints();
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let server, serverOutput = '';
  async function stop() {
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  }
  t.after(stop);
  async function start(entrypoint = 'server/index.mjs', analysis = false) {
    server = spawn(process.execPath, ['--import', './tests/chatask-upstream.mock.mjs', '--import', './tests/analysis-provider.mock.mjs', entrypoint], { env: {
      PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      DATABASE_URL: target, BOOTSTRAP_EMAIL: 'owner-a@example.invalid', BOOTSTRAP_PASSWORD: password,
      HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin,
      ...(analysis?{OPENROUTER_API_KEY:'synthetic-provider-key',ANALYSIS_FIXTURE:'1'}:{}),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', c => { serverOutput += c; }); server.stderr.on('data', c => { serverOutput += c; });
    for (let tries = 0; tries < 200; tries++) {
      if (server.exitCode !== null) throw new Error(`Test server failed: ${serverOutput}`);
      try { if ((await fetch(`${origin}/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local server did not become healthy');
  }
  await t.test('migration adds only the new table and preserves every existing row', async () => {
    await start();
    assert.deepEqual(await fingerprints(), before);
    const [afterTables] = await admin.query('SHOW TABLES');
    assert.deepEqual(afterTables.map(row => Object.values(row)[0]).filter(name => !tableNames.includes(name)), ['chatask_connections', 'chatask_operations', 'chatask_project_rooms', 'knowledge_analyses', 'knowledge_analysis_chunks', 'second_brain_tasks']);
  });
  await t.test('second startup is idempotent and keeps existing users and rows', async () => {
    await stop(); await start(); assert.deepEqual(await fingerprints(), before);
  });
  async function request(path, { user = 'owner-a', method = 'GET', body, requestOrigin = origin } = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(cookies[user] ? { cookie: cookies[user] } : {}),
      ...(body ? { 'Content-Type': 'application/json', Origin: requestOrigin } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), response };
  }
  const cookies = {};
  await t.test('existing login works for owner, member and unrelated user', async () => {
    for (const user of ['owner-a', 'member-a', 'owner-b']) {
      const result = await request('/api/auth/login', { user: '', method: 'POST', body: { email: `${user}@example.invalid`, password } });
      assert.equal(result.status, 200); cookies[user] = result.response.headers.get('set-cookie').split(';')[0];
      assert.match(result.response.headers.get('set-cookie'), /HttpOnly/);
    }
  });
  const paths = ['/api/projects/project-a/knowledge/search?q=Teste', '/api/projects/project-a/tasks'];

  let taskBaseline;
  await t.test('project structure cloning preserves hierarchy with new IDs and no project data',async()=>{
    await admin.execute('INSERT INTO structure_nodes VALUES (?,?,?,?,?,?,?)',['parent-a','project-a',null,'Equipamentos',3,0,stamp]);
    await admin.execute('INSERT INTO structure_nodes VALUES (?,?,?,?,?,?,?)',['child-a','project-a','parent-a','Cubículos',2,0,stamp]);
    await admin.execute('INSERT INTO structure_nodes VALUES (?,?,?,?,?,?,?)',['archived-a','project-a',null,'Arquivado',8,1,stamp]);
    const clone=await request('/api/projects',{method:'POST',body:{name:'Guaporé sintético',structureProjectId:'project-a',withTemplate:false}});
    assert.equal(clone.status,201);const id=clone.data.id;
    const [nodes]=await admin.execute('SELECT * FROM structure_nodes WHERE project_id=? ORDER BY sort_order',[id]);
    assert.equal(nodes.length,2);assert.equal(nodes[0].title,'Cubículos');assert.equal(nodes[0].parent_id,nodes[1].id);assert.notEqual(nodes[1].id,'parent-a');
    for(const table of ['items','sources','project_context_entries','second_brain_tasks','chatask_project_rooms']){const [[row]]=await admin.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`,[id]);assert.equal(row.n,0);}
    const [members]=await admin.execute('SELECT * FROM memberships WHERE project_id=?',[id]);assert.equal(members.length,1);assert.equal(members[0].role,'owner');
    assert.equal((await request('/api/projects',{user:'owner-b',method:'POST',body:{name:'Sem acesso',structureProjectId:'project-a'}})).status,403);
    const [[denied]]=await admin.execute('SELECT COUNT(*) AS n FROM projects WHERE name=?',['Sem acesso']);assert.equal(denied.n,0);
    taskBaseline=await fingerprints();
  });
  await t.test('Chatask connects per session without returning or storing a clear token',async()=>{
    assert.equal((await request('/api/chatask/connection')).data.connected,false);
    assert.equal((await request('/api/chatask/rooms')).status,401);
    const c=await request('/api/chatask/connection',{method:'POST',body:{email:'fixture@example.invalid',password:'fixture-password'}});
    assert.equal(c.status,200);assert.doesNotMatch(JSON.stringify(c.data),/fixture-token/);
    const [[stored]]=await admin.execute('SELECT * FROM chatask_connections WHERE user_id=?',['owner-a']);assert.ok(stored.encrypted_token);assert.doesNotMatch(stored.encrypted_token,/fixture-token/);
    assert.equal((await request('/api/chatask/connection',{user:'member-a'})).data.connected,false);
  });
  await t.test('project room binding requires owner membership and does not steal another project binding',async()=>{
    assert.equal((await request('/api/projects/project-a/chatask',{method:'PUT',body:{roomId:11},user:'member-a'})).status,403);
    assert.equal((await request('/api/projects/project-a/chatask',{method:'PUT',body:{roomId:999}})).status,403);
    assert.equal((await request('/api/projects/project-a/chatask',{method:'PUT',body:{roomId:11}})).status,200);
    await request('/api/chatask/connection',{user:'owner-b',method:'POST',body:{email:'fixture@example.invalid',password:'fixture-password'}});
    assert.equal((await request('/api/projects/project-b/chatask',{user:'owner-b',method:'PUT',body:{roomId:11}})).status,409);
    assert.equal((await request('/api/projects/project-a/chatask')).data.room.id,11);
    assert.equal((await request('/api/projects/project-b/chatask',{user:'owner-b'})).data.room,null);
  });
  await t.test('Chatask tasks are live room records; foreign IDs and unsupported personal-task operations are rejected',async()=>{
    const list=await request('/api/projects/project-a/chatask/tasks');assert.equal(list.status,200);assert.equal(list.data.tasks[0].description,'Tarefa da sala 11');
    assert.equal((await request('/api/projects/project-a/chatask/tasks',{user:'owner-b'})).status,403);
    const edit=await request('/api/projects/project-a/chatask/tasks/101',{method:'PATCH',body:{roomId:11,description:'Descrição revista',updatedAt:'2026-11-01T00:00:00.000Z'}});assert.equal(edit.status,200);
    assert.equal((await request('/api/projects/project-a/chatask/tasks')).data.tasks[0].description,'Descrição revista');
    assert.equal((await request('/api/projects/project-a/chatask/tasks/999',{method:'PATCH',body:{roomId:11,status:'completed',updatedAt:'stamp'}})).status,404);
    assert.equal((await request('/api/projects/project-a/chatask/tasks/101',{method:'PATCH',body:{roomId:12,status:'completed',updatedAt:'stamp'}})).status,409);
    assert.equal((await request('/api/projects/project-a/chatask/tasks/101',{method:'PATCH',body:{roomId:11,status:'completed',updatedAt:'old'}})).status,409);
    assert.equal((await request('/api/projects/project-a/chatask/tasks/101',{method:'PATCH',body:{roomId:11,dueDate:'2026-12-01'}})).status,400);
    const latest=(await request('/api/projects/project-a/chatask/tasks')).data.tasks[0];
    assert.equal((await request('/api/projects/project-a/chatask/tasks/101',{method:'PATCH',body:{roomId:11,status:'completed',updatedAt:latest.updatedAt}})).status,200);
    assert.equal((await request('/api/projects/project-a/chatask/tasks')).data.tasks[0].status,'completed');
  });
  await t.test('duplicate Chatask creation and ambiguous timeouts are never automatically retried',async()=>{
    const operationId=randomUUID(), body={roomId:11,description:'Nova tarefa sintética',operationId};
    assert.equal((await request('/api/projects/project-a/chatask/tasks',{method:'POST',body})).data.created,true);
    assert.equal((await request('/api/projects/project-a/chatask/tasks',{method:'POST',body})).status,409);
    assert.equal((await request('/api/projects/project-a/chatask/tasks')).data.tasks.length,2);
    const uncertain={...body,operationId:randomUUID(),description:'simulate-timeout'};
    assert.equal((await request('/api/projects/project-a/chatask/tasks',{method:'POST',body:uncertain})).status,502);
    assert.equal((await request('/api/projects/project-a/chatask/tasks',{method:'POST',body:uncertain})).status,409);
    const [[operation]]=await admin.execute('SELECT state FROM chatask_operations WHERE id=?',[uncertain.operationId]);assert.equal(operation.state,'uncertain');
  });
  await t.test('Chatask disconnect removes only this session connection and never the project room',async()=>{
    assert.equal((await request('/api/chatask/connection',{method:'DELETE',body:{}})).status,200);
    assert.equal((await request('/api/chatask/connection')).data.connected,false);
    assert.equal((await request('/api/projects/project-a/chatask')).data.room.id,11);
    assert.equal((await request('/api/chatask/connection',{user:'owner-b'})).data.connected,true);
  });
  await t.test('anonymous and unrelated users cannot read search or tasks', async () => {
    for (const path of paths) {
      assert.equal((await request(path, { user: '' })).status, 401);
      assert.equal((await request(path, { user: 'owner-b' })).status, 403);
    }
  });
  await t.test('search covers four record types and excludes other projects and archived context', async () => {
    const result = await request(paths[0], { user: 'member-a' });
    assert.equal(result.status, 200);
    assert.deepEqual(new Set(result.data.results.map(x => x.kind)), new Set(['assunto','historico','fonte','contexto']));
    assert.equal(result.data.results.length, 4);
    assert.ok(result.data.results.every(x => x.id.endsWith('-a')));
  });
  await t.test('search treats SQL injection and wildcard inputs as literal text', async () => {
    for (const q of ["' OR 1=1 --", '%%', '__']) {
      const result = await request(`/api/projects/project-a/knowledge/search?q=${encodeURIComponent(q)}`);
      assert.equal(result.status, 200); assert.equal(result.data.results.length, 0);
    }
    const result = await request('/api/projects/project-a/knowledge/search?q=100%25');
    assert.equal(result.data.results.length, 1);
    assert.equal((await request('/api/projects/project-a/knowledge/search?q=a')).status, 400);
  });
  const tasksPath = '/api/projects/project-a/tasks';
  await t.test('task creation rejects anonymous, unrelated users and cross-origin requests', async () => {
    const body = { title: 'Synthetic task' };
    assert.equal((await request(tasksPath,{user:'',method:'POST',body})).status,401);
    assert.equal((await request(tasksPath,{user:'owner-b',method:'POST',body})).status,403);
    assert.equal((await request(tasksPath,{method:'POST',body,requestOrigin:'https://untrusted.example.invalid'})).status,403);
  });
  await t.test('task creation rejects cross-project item links, empty titles and invalid statuses', async () => {
    for (const body of [{title:'Task',item_id:'item-b'}, {title:' '}, {title:'Task',status:'invalid'}]) {
      assert.equal((await request(tasksPath,{method:'POST',body})).status,400);
    }
  });
  await t.test('task creation rejects impossible dates and truncated or non-string inputs', async () => {
    for (const due_date of ['2026-02-30','2026-13-01','2026-01-01suffix',1234,{}]) {
      assert.equal((await request(tasksPath,{method:'POST',body:{title:'Task',due_date}})).status,400);
    }
  });
  let taskId;
  await t.test('a project member creates a task with a valid leap-day deadline', async () => {
    const result = await request(tasksPath,{user:'member-a',method:'POST',body:{title:'Tarefa sintética',item_id:'item-a',due_date:'2028-02-29'}});
    assert.equal(result.status,201); taskId=result.data.id;
    const listing=await request(tasksPath);
    assert.equal(listing.data.tasks.length,1); assert.equal(listing.data.tasks[0].created_by,'member-a');
  });
  await t.test('updates remain scoped to project membership and task ownership by project', async () => {
    const body={status:'concluido'};
    assert.equal((await request(`${tasksPath}/${taskId}`,{user:'',method:'PATCH',body})).status,401);
    assert.equal((await request(`${tasksPath}/${taskId}`,{user:'owner-b',method:'PATCH',body})).status,403);
    assert.equal((await request(`/api/projects/project-b/tasks/${taskId}`,{user:'owner-b',method:'PATCH',body})).status,404);
  });
  await t.test('invalid updates are rejected without modifying the task', async () => {
    const old=(await request(tasksPath)).data.tasks;
    for(const body of [{due_date:'2027-02-29'},{due_date:'2026-01-01tail'},{title:''},{status:'invalid'}]) {
      assert.equal((await request(`${tasksPath}/${taskId}`,{method:'PATCH',body})).status,400);
    }
    assert.deepEqual((await request(tasksPath)).data.tasks,old);
  });
  await t.test('valid partial update preserves unchanged task fields', async () => {
    assert.equal((await request(`${tasksPath}/${taskId}`,{method:'PATCH',body:{status:'concluido'}})).status,200);
    const task=(await request(tasksPath)).data.tasks[0];
    assert.equal(task.status,'concluido'); assert.equal(task.title,'Tarefa sintética'); assert.equal(task.item_id,'item-a');
  });
  await t.test('legacy state, history, context and login continue working', async () => {
    const state=await request('/api/state?projectId=project-a');
    assert.equal(state.status,200); assert.equal(state.data.items.length,1); assert.equal(state.data.sources.length,1);
    assert.equal((await request('/api/projects/project-a/history')).data.updates.length,1);
    assert.equal((await request('/api/auth/me')).status,200);
    assert.equal((await request('/api/state?projectId=project-b')).status,403);
  });
  await t.test('new routes do not alter existing business records or user passwords', async () => {
    const after=await fingerprints(); delete after.sessions;
    const expected={...taskBaseline};delete expected.sessions;
    assert.deepEqual(after,expected);
  });
  await t.test('updated mailer generates the existing invitation format locally without sending email', async () => {
    const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'});
    const result=await transport.sendMail({from:'noreply@example.invalid',to:'member@example.invalid',subject:'Convite para Projeto teste',text:'Convite sintético para teste local.'});
    assert.deepEqual(result.envelope.to,['member@example.invalid']); assert.match(result.message.toString(),/Subject: Convite/);
  });
  await t.test('natural language retrieval finds an unaccented equipment/location question without an AI key', async () => {
    const result=await request('/api/projects/project-a/knowledge/ask',{method:'POST',body:{question:'me fala tudo sobre o cubículo de Ceara Mirim'}});
    assert.equal(result.status,200);assert.equal(result.data.status,'unavailable');
    assert.ok(result.data.sources.some(s=>s.kind==='assunto' && s.id==='item-a'));
    assert.ok(result.data.sources.every(s=>!s.id.endsWith('-b')));
    assert.deepEqual(result.data.paragraphs,[]);
  });
  await t.test('saved synthesis and executive summary appear as dated evidence while archived topics stay excluded',async()=>{
    try {
      for(const nodeId of ['parent-a','archived-a']) await admin.execute('INSERT INTO topic_summaries (node_id,project_id,revision,summary,important_change,analysis_status,generated_at) VALUES (?,?,?,?,?,?,?)',[nodeId,'project-a','synthetic','Cubículo Ceará-Mirim: revisão pela engenharia.','','completed',stamp]);
      await admin.execute('INSERT INTO topic_executive_summaries (node_id,project_id,source_hash,summary,analysis_status,generated_at) VALUES (?,?,?,?,?,?)',['parent-a','project-a','synthetic','Cubículo Ceará-Mirim: pendência resumida.','completed',stamp]);
      const result=await request('/api/projects/project-a/knowledge/ask',{method:'POST',body:{question:'Cubículo Ceará Mirim'}});
      assert.equal(result.status,200);assert.ok(result.data.sources.some(s=>s.kind==='sintese' && s.created_at===stamp));assert.ok(result.data.sources.some(s=>s.kind==='resumo'));assert.ok(result.data.sources.every(s=>s.id!=='archived-a'));
    }finally{await admin.execute('DELETE FROM topic_summaries WHERE project_id=?',['project-a']);await admin.execute('DELETE FROM topic_executive_summaries WHERE project_id=?',['project-a']);}
  });
  await t.test('AI question endpoint enforces membership, authentication, origin and input validation', async () => {
    const path='/api/projects/project-a/knowledge/ask',body={question:'Cubículo Ceará Mirim'};
    assert.equal((await request(path,{user:'',method:'POST',body})).status,401);
    assert.equal((await request(path,{user:'owner-b',method:'POST',body})).status,403);
    assert.equal((await request(path,{method:'POST',body,requestOrigin:'https://untrusted.example.invalid'})).status,403);
    for(const question of ['',{},'a'.repeat(4001)]) assert.equal((await request(path,{method:'POST',body:{question}})).status,400);
  });
  await t.test('conversation rejects malformed and oversized context before consulting the project', async () => {
    for(const history of [{},[{role:'system',content:'x'}],Array(7).fill({question:'Teste',answer:'Texto'})]) {
      const result=await request('/api/projects/project-a/knowledge/ask',{method:'POST',body:{question:'Cubículo',history}});assert.equal(result.status,400);
    }
  });
  await t.test('questions without evidence return no fabricated answer or unrelated source', async () => {
    const result=await request('/api/projects/project-a/knowledge/ask',{method:'POST',body:{question:'Telescópio orbital plutoniano'}});
    assert.equal(result.status,200);assert.equal(result.data.status,'no_evidence');assert.deepEqual(result.data.sources,[]);
  });

  const analysisBase='/api/projects/project-a/knowledge/analyses';
  const advanceAnalysis=async(id,untilComplete=true)=>{
    for(let i=0;i<150;i++){
      const value=await request(`${analysisBase}/${id}`);
      assert.equal(value.status,200);
      if(value.data.state==='paused')t.diagnostic('Synthetic analysis paused as expected or awaiting test inspection.');
      if(value.data.state==='complete'||value.data.state==='paused')return value.data;
      if(value.data.state==='ready')await request(`${analysisBase}/${id}/advance`,{method:'POST',body:{}});
      if(!untilComplete&&value.data.progress.completed>0)return value.data;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('Analysis did not finish');
  };
  let analysisId;
  await t.test('analysis jobs protect project, user, origin and idempotent creation',async()=>{
    await stop();await start('server/index.mjs',true);
    await request('/api/chatask/connection',{method:'POST',body:{email:'fixture@example.invalid',password:'fixture-password'}});
    await admin.execute('INSERT INTO topic_summaries (node_id,project_id,revision,summary,important_change,analysis_status,generated_at) VALUES (?,?,?,?,?,?,?)',['parent-a','project-a','synthetic','Síntese completa. '.repeat(8000)+'TASK-LAST','','completed',stamp]);
    analysisId=randomUUID();const body={id:analysisId,question:'Leia todas as sínteses e compare as tarefas',history:[]};
    assert.equal((await request(analysisBase,{method:'POST',body,user:''})).status,401);
    assert.equal((await request(analysisBase,{method:'POST',body,user:'owner-b'})).status,403);
    assert.equal((await request(analysisBase,{method:'POST',body,requestOrigin:'https://untrusted.example.invalid'})).status,403);
    assert.equal((await request(analysisBase,{method:'POST',body})).status,201);
    assert.equal((await request(analysisBase,{method:'POST',body})).status,200);
    assert.equal((await request(`${analysisBase}/${analysisId}`,{user:'member-a'})).status,404);
    assert.equal((await request(`${analysisBase}/${analysisId}/advance`,{user:'member-a',method:'POST',body:{}})).status,404);
    assert.equal((await request(analysisBase,{method:'POST',body:{...body,id:randomUUID()}})).status,409);
  });
  await t.test('full corpus analysis survives restart, reads final passages and compares the last remote task batch',async()=>{
    const partial=await advanceAnalysis(analysisId,false);assert.ok(partial.progress.completed>0);assert.ok(partial.progress.total>24);
    const [[savedProgress]]=await admin.execute('SELECT progress_json FROM knowledge_analyses WHERE id=?',[analysisId]);
    const saved=JSON.parse(savedProgress.progress_json);assert.equal(saved.rawSupport,true);assert.ok(saved.supportNotes.some(n=>n.text.includes('Teste contexto a')));
    const [supportRead]=await admin.execute('SELECT source_json,reviewed FROM knowledge_analysis_chunks WHERE analysis_id=?',[analysisId]);
    assert.ok(supportRead.filter(r=>JSON.parse(r.source_json).kind==='contexto').every(r=>r.reviewed===1));
    await stop();await admin.execute("UPDATE knowledge_analyses SET lease_until=? WHERE id=? AND state='working'",['2000-01-01',analysisId]);await start('server/index.mjs',true);
    const result=await advanceAnalysis(analysisId);assert.equal(result.state,'complete');assert.equal(result.progress.completed,result.progress.total);
    assert.equal(result.result.coverage.history_included,false);assert.equal(result.result.coverage.originals_included,false);
    const [readChunks]=await admin.execute('SELECT source_json FROM knowledge_analysis_chunks WHERE analysis_id=?',[analysisId]);
    assert.ok(readChunks.every(r=>!['assunto','historico','fonte','tarefa'].includes(JSON.parse(r.source_json).kind)));
    assert.equal(result.result.coverage.task_count,300);assert.equal(result.result.coverage.comparison_complete,true);
    assert.equal(result.result.comparisons.length,1);assert.equal(result.result.comparisons[0].classification,'existing');assert.equal(result.result.comparisons[0].matches[0].task_id,1300);
    assert.ok(result.result.sources.some(s=>s.text.includes('TASK-LAST')));assert.ok(result.result.sources.every(s=>s.id!=='source-b'&&s.id!=='item-b'));
    const [[remaining]]=await admin.execute('SELECT COUNT(*) AS n FROM knowledge_analysis_chunks WHERE analysis_id=? AND reviewed=0',[analysisId]);assert.equal(remaining.n,0);
    const after=await request(`${analysisBase}/${analysisId}/advance`,{method:'POST',body:{}});assert.equal(after.data.state,'complete');
    assert.doesNotMatch(JSON.stringify(result),/synthetic-provider-key|fixture-token|encrypted_token/);
  });
  await t.test('unavailable room access remains incomplete and never produces false new tasks',async()=>{
    const id=randomUUID();await request(analysisBase,{user:'member-a',method:'POST',body:{id,question:'Compare as tarefas com as sínteses'}});
    for(let i=0;i<150;i++){
      const value=(await request(`${analysisBase}/${id}`,{user:'member-a'})).data;
      if(value.state==='complete'){
        assert.equal(value.result.coverage.comparison_complete,false);assert.ok(value.result.comparisons.length>0);assert.ok(value.result.comparisons.every(c=>c.classification==='not_compared'));return;
      }
      assert.notEqual(value.state,'paused');
      if(value.state==='ready')await request(`${analysisBase}/${id}/advance`,{user:'member-a',method:'POST',body:{}});
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('Member analysis did not finish');
  });
  await t.test('provider failure pauses honestly; resume and concurrent advance do not duplicate results',async()=>{
    const id=randomUUID();await request(analysisBase,{method:'POST',body:{id,question:'Comparar e pausar uma vez para teste'}});
    const paused=await advanceAnalysis(id);assert.equal(paused.state,'paused');assert.equal(paused.result,null);
    await Promise.all(Array.from({length:5},()=>request(`${analysisBase}/${id}/advance`,{method:'POST',body:{}})));
    const result=await advanceAnalysis(id);assert.equal(result.state,'complete');assert.equal(result.result.comparisons.length,1);
    const [[row]]=await admin.execute('SELECT SUM(reviewed) AS read_count,COUNT(*) AS total FROM knowledge_analysis_chunks WHERE analysis_id=?',[id]);assert.equal(Number(row.read_count),row.total);
  });
  await t.test('summary-only proposals do not fetch the room and keep context in every synthesis review',async()=>{
    const id=randomUUID();await request(analysisBase,{method:'POST',body:{id,question:'Faça uma lista de tarefas a partir das sínteses'}});
    const value=await advanceAnalysis(id);assert.equal(value.state,'complete');
    assert.equal(value.result.coverage.task_status,'not_requested');assert.equal(value.result.coverage.task_count,null);
    assert.equal(value.result.coverage.history_included,false);assert.equal(value.result.coverage.originals_included,false);
    assert.ok(value.result.comparisons.length);assert.ok(value.result.comparisons.every(c=>c.classification==='not_compared'));
  });
  await t.test('unfinished legacy jobs replan without preserving the oversized historical queue',async()=>{
    const id=randomUUID();await request(analysisBase,{method:'POST',body:{id,question:'Resumo a partir das sínteses'}});
    await admin.execute("UPDATE knowledge_analyses SET state='paused',progress_json=? WHERE id=?",[JSON.stringify({phase:'review',completed:88,total:1103}),id]);
    await admin.execute('INSERT INTO knowledge_analysis_chunks (analysis_id,sequence_number,source_json,body) VALUES (?,?,?,?)',[id,1103,JSON.stringify({kind:'historico',id:'obsolete'}),'Legacy history']);
    await request(`${analysisBase}/${id}/advance`,{method:'POST',body:{}});
    const value=await advanceAnalysis(id);assert.equal(value.state,'complete');assert.ok(value.progress.total<1103);
    const [old]=await admin.execute('SELECT body FROM knowledge_analysis_chunks WHERE analysis_id=? AND sequence_number=1103',[id]);assert.equal(old.length,0);
  });
  await t.test('explicit detailed history and originals are included when requested',async()=>{
    const id=randomUUID();await request(analysisBase,{method:'POST',body:{id,question:'Consulte o histórico detalhado e os documentos originais'}});
    const value=await advanceAnalysis(id);assert.equal(value.state,'complete');assert.equal(value.result.coverage.history_included,true);assert.equal(value.result.coverage.originals_included,true);
    const [chunks]=await admin.execute('SELECT source_json FROM knowledge_analysis_chunks WHERE analysis_id=?',[id]);
    for(const kind of ['historico','assunto','fonte'])assert.ok(chunks.some(r=>JSON.parse(r.source_json).kind===kind));
  });
  await t.test('cancellation invalidates work and lets a new analysis start',async()=>{
    const id=randomUUID();await request(analysisBase,{method:'POST',body:{id,question:'Análise para encerrar'}});
    assert.equal((await request(`${analysisBase}/${id}/cancel`,{method:'POST',body:{}})).status,200);
    assert.equal((await request(`${analysisBase}/${id}/advance`,{method:'POST',body:{}})).data.state,'cancelled');
    await admin.execute('DELETE FROM topic_summaries WHERE project_id=?',['project-a']);
  });
  await t.test('logout invalidates the existing session', async () => {
    assert.equal((await request('/api/auth/logout',{method:'POST',body:{}})).status,200);
    assert.equal((await request(tasksPath)).status,401);
  });
  await t.test('the previous application starts with the added table and preserves all tasks on rollback', async () => {
    await stop();
    await admin.execute('DELETE FROM topic_summaries WHERE project_id=?',['project-a']);
    await admin.execute('DELETE FROM topic_executive_summaries WHERE project_id=?',['project-a']);
    const saved = await fingerprints();
    const [savedTasks] = await admin.query('SELECT * FROM second_brain_tasks');
    await mkdir('node_modules/.cache', {recursive:true});
    const previousApp = await mkdtemp(resolve('node_modules/.cache/rollback-'));
    t.after(() => rm(previousApp, {recursive:true,force:true}));
    const archive = execFileSync('git', ['archive','17ce042768bd21c8adb55bbf114a4f9981de5b0f','server','estrutura-inicial.json']);
    execFileSync('tar',['-x','-C',previousApp],{input:archive});
    await start(`${previousApp}/server/index.mjs`);
    assert.deepEqual(await fingerprints(),saved);
    const [tasksAfterRollback] = await admin.query('SELECT * FROM second_brain_tasks');
    assert.deepEqual(tasksAfterRollback,savedTasks);
  });
});
