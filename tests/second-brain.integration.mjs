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
    await admin.execute('INSERT INTO items (id,project_id,title,summary,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [`item-${suffix}`, `project-${suffix}`, `Teste exclusivo ${suffix} 100%`, `Evidência ${suffix}`, 'pendente', stamp, stamp]);
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
  async function start(entrypoint = 'server/index.mjs') {
    server = spawn(process.execPath, [entrypoint], { env: {
      PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      DATABASE_URL: target, BOOTSTRAP_EMAIL: 'owner-a@example.invalid', BOOTSTRAP_PASSWORD: password,
      HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin,
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
    assert.deepEqual(afterTables.map(row => Object.values(row)[0]).filter(name => !tableNames.includes(name)), ['second_brain_tasks']);
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
    const expected={...before};delete expected.sessions;
    assert.deepEqual(after,expected);
  });
  await t.test('updated mailer generates the existing invitation format locally without sending email', async () => {
    const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'});
    const result=await transport.sendMail({from:'noreply@example.invalid',to:'member@example.invalid',subject:'Convite para Projeto teste',text:'Convite sintético para teste local.'});
    assert.deepEqual(result.envelope.to,['member@example.invalid']); assert.match(result.message.toString(),/Subject: Convite/);
  });
  await t.test('logout invalidates the existing session', async () => {
    assert.equal((await request('/api/auth/logout',{method:'POST',body:{}})).status,200);
    assert.equal((await request(tasksPath)).status,401);
  });
  await t.test('the previous application starts with the added table and preserves all tasks on rollback', async () => {
    await stop();
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
