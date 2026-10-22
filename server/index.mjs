import express from 'express';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, createProject, initializeDatabase } from './db.mjs';
import { classifyNode, extractItems } from './ai.mjs';
import { MAX_SOURCE_TEXT } from './file-text.mjs';
import { prepareTopicSummaries, refreshTopicSummariesForProject, retryTopicSummary } from './topic-summaries.mjs';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expected) return res.status(403).json({ error: 'Origem não permitida' });
  }
  next();
});

const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const text = (value, max = 255) => String(value || '').trim().slice(0, max);
const fail = (res, code, message) => res.status(code).json({ error: message });
const run = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const updateTopicSummaries = (projectId) => { void refreshTopicSummariesForProject(projectId).catch((error) => console.error('Falha ao atualizar sínteses:', error)); };
async function lockOrganization(connection, projectId, itemId, title, node) {
  if (!title && !node) return;
  await connection.execute(`INSERT INTO item_organization (item_id,project_id,title_locked,node_locked,updated_at) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE title_locked=GREATEST(title_locked,VALUES(title_locked)),node_locked=GREATEST(node_locked,VALUES(node_locked)),updated_at=VALUES(updated_at)`,
    [itemId, projectId, Number(title), Number(node), now()]);
}

function readCookie(req, name) {
  return (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  res.cookie('organizador_session', token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 });
}

async function issueSession(req, res, userId) {
  const token = randomBytes(32).toString('hex');
  await db().execute('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',
    [hash(token), userId, new Date(Date.now() + 30 * 86400000).toISOString()]);
  setSessionCookie(req, res, token);
}

const loginAttempts = new Map();
app.post('/api/auth/login', run(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const key = `${req.ip}:${email}`;
  const previous = loginAttempts.get(key);
  const attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: 0 };
  if (attempt.count >= 8 && attempt.until > Date.now()) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
  const [rows] = await db().execute('SELECT id,email,password_hash FROM users WHERE email=?', [email]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    loginAttempts.set(key, { count: attempt.count + 1, until: Date.now() + 15 * 60000 });
    return fail(res, 401, 'E-mail ou senha inválidos');
  }
  loginAttempts.delete(key);
  await issueSession(req, res, rows[0].id);
  res.json({ user: { id: rows[0].id, email: rows[0].email } });
}));

app.post('/api/auth/logout', run(async (req, res) => {
  const token = readCookie(req, 'organizador_session');
  if (token) await db().execute('DELETE FROM sessions WHERE token_hash=?', [hash(token)]);
  res.clearCookie('organizador_session', { path: '/' });
  res.json({ ok: true });
}));

async function requireUser(req, res, next) {
  try {
    const token = readCookie(req, 'organizador_session');
    if (!token) return fail(res, 401, 'Faça login para continuar');
    const [rows] = await db().execute(
      'SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
      [hash(token), now()]);
    if (!rows.length) return fail(res, 401, 'Sessão expirada');
    req.user = rows[0];
    next();
  } catch (error) { next(error); }
}

async function membership(req, res, next) {
  try {
    const [rows] = await db().execute('SELECT role FROM memberships WHERE project_id=? AND user_id=?', [req.params.projectId, req.user.id]);
    if (!rows.length) return fail(res, 403, 'Você não participa deste projeto');
    req.role = rows[0].role;
    next();
  } catch (error) { next(error); }
}

const ownerOnly = (req, res, next) => req.role === 'owner' ? next() : fail(res, 403, 'Somente o responsável pelo projeto pode alterar esta configuração');

app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

app.get('/api/state', requireUser, run(async (req, res) => {
  const [projects] = await db().execute(
    'SELECT p.id,p.name,p.description,p.created_at,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.created_at DESC', [req.user.id]);
  const projectId = text(req.query.projectId, 36);
  if (!projectId) return res.json({ user: req.user, projects });
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) return fail(res, 403, 'Projeto não autorizado');
  const [[nodes], [sources], [items], [members], [invitations]] = await Promise.all([
    db().execute('SELECT id,parent_id,title,sort_order,archived,created_at FROM structure_nodes WHERE project_id=? ORDER BY sort_order,title', [projectId]),
    db().execute('SELECT s.id,s.title,s.kind,s.body,s.file_name,s.content_type,s.analysis_status,s.analysis_error,s.created_at,u.email AS author_email FROM sources s LEFT JOIN users u ON u.id=s.author_id WHERE s.project_id=? ORDER BY s.created_at DESC LIMIT 200', [projectId]),
    db().execute('SELECT i.*,s.title AS source_title FROM items i LEFT JOIN sources s ON s.id=i.latest_source_id WHERE i.project_id=? ORDER BY i.updated_at DESC', [projectId]),
    db().execute('SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.role,u.email', [projectId]),
    db().execute('SELECT id,email,role,expires_at,accepted_at,created_at FROM invitations WHERE project_id=? ORDER BY created_at DESC LIMIT 100', [projectId]),
  ]);
  if (items.length) {
    const ids = items.map((item) => item.id);
    const itemById = new Map(items.map((item) => [item.id, item]));
    for (let start = 0; start < ids.length; start += 400) {
      const batch = ids.slice(start, start + 400);
      const placeholders = batch.map(() => '?').join(',');
      const [history] = await db().execute(`SELECT u.item_id,u.summary,u.created_at,a.email AS author_email
        FROM item_updates u LEFT JOIN users a ON a.id=u.author_id
        WHERE u.item_id IN (${placeholders}) ORDER BY u.item_id,u.created_at DESC,u.id DESC`, batch);
      for (const update of history) {
        const item = itemById.get(update.item_id);
        if (!item) continue;
        item.update_count = (item.update_count || 0) + 1;
        if (item.update_count === 1) {
          item.latest_update = update.summary;
          item.latest_update_at = update.created_at;
          item.latest_update_author = update.author_email;
        }
      }
    }
  }
  if (sources.length) {
    const sourceIds = sources.map((source) => source.id);
    const placeholders = sourceIds.map(() => '?').join(',');
    const [counts] = await db().execute(`SELECT source_id,COUNT(DISTINCT item_id) AS topic_count FROM item_updates WHERE source_id IN (${placeholders}) GROUP BY source_id`, sourceIds);
    const bySource = new Map(counts.map((row) => [row.source_id, Number(row.topic_count)]));
    for (const source of sources) source.topic_count = bySource.get(source.id) || 0;
  }
  const topicSummaries = await prepareTopicSummaries(projectId, nodes, items);
  res.json({ user: req.user, projects, project, nodes, sources, items, members, invitations, topicSummaries });
}));

app.post('/api/projects/:projectId/topics/:nodeId/summary/retry', requireUser, membership, run(async (req, res) => {
  const found = await retryTopicSummary(req.params.projectId, req.params.nodeId);
  if (!found) return fail(res, 404, 'Síntese não encontrada');
  res.json({ status: 'pending' });
}));

app.post('/api/projects', requireUser, run(async (req, res) => {
  const name = text(req.body.name, 200);
  if (name.length < 3) return fail(res, 400, 'Dê um nome ao projeto');
  const id = await createProject(name, text(req.body.description, 2000), req.user.id, req.body.withTemplate !== false);
  res.status(201).json({ id });
}));

app.post('/api/projects/:projectId/invitations', requireUser, membership, ownerOnly, run(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Informe um e-mail válido');
  const [members] = await db().execute('SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND u.email=?', [req.params.projectId, email]);
  if (members.length) return fail(res, 409, 'Esta pessoa já participa do projeto');
  const token = randomBytes(32).toString('hex');
  const [pending] = await db().execute('SELECT id FROM invitations WHERE project_id=? AND email=? AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1', [req.params.projectId, email]);
  const id = pending[0]?.id || randomUUID();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    if (pending.length) {
      const [updated] = await connection.execute('UPDATE invitations SET token_hash=?,invited_by=?,expires_at=?,created_at=? WHERE id=? AND project_id=? AND accepted_at IS NULL',
        [hash(token), req.user.id, expires, now(), id, req.params.projectId]);
      if (!updated.affectedRows) { const error = new Error('O convite mudou. Tente novamente.'); error.status = 409; throw error; }
    }
    else await connection.execute('INSERT INTO invitations (id,project_id,email,role,token_hash,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, req.params.projectId, email, 'member', hash(token), req.user.id, expires, now()]);
    await connection.execute('DELETE FROM invitations WHERE project_id=? AND email=? AND accepted_at IS NULL AND id<>?', [req.params.projectId, email, id]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const inviteUrl = `${origin}/?convite=${encodeURIComponent(token)}`;
  let emailed = false;
  if (process.env.SMTP_HOST && process.env.SMTP_FROM) {
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT || 587) === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined });
    const [projects] = await db().execute('SELECT name FROM projects WHERE id=?', [req.params.projectId]);
    try {
      await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: `Convite para ${projects[0].name}`, text: `Você foi convidado para acompanhar o projeto ${projects[0].name}. Abra o link para aceitar: ${inviteUrl}\n\nO convite expira em 7 dias.` });
      emailed = true;
    } catch (error) {
      console.error('Falha ao enviar convite:', error.message);
    }
  }
  res.status(201).json({ id, emailed, renewed: Boolean(pending.length), inviteUrl: emailed ? undefined : inviteUrl });
}));

app.post('/api/projects/:projectId/invitations/:invitationId/link', requireUser, membership, ownerOnly, run(async (req, res) => {
  const [rows] = await db().execute('SELECT id,email FROM invitations WHERE id=? AND project_id=? AND accepted_at IS NULL', [req.params.invitationId, req.params.projectId]);
  if (!rows.length) return fail(res, 404, 'Convite pendente não encontrado');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const [updated] = await db().execute('UPDATE invitations SET token_hash=?,expires_at=?,created_at=?,invited_by=? WHERE id=? AND project_id=? AND accepted_at IS NULL',
    [hash(token), expiresAt, now(), req.user.id, req.params.invitationId, req.params.projectId]);
  if (!updated.affectedRows) return fail(res, 409, 'O convite já foi aceito ou cancelado. Atualize a lista.');
  const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  res.json({ email: rows[0].email, inviteUrl: `${origin}/?convite=${encodeURIComponent(token)}`, expiresAt });
}));

app.delete('/api/projects/:projectId/invitations/:invitationId', requireUser, membership, ownerOnly, run(async (req, res) => {
  const [result] = await db().execute('DELETE FROM invitations WHERE id=? AND project_id=? AND accepted_at IS NULL', [req.params.invitationId, req.params.projectId]);
  if (!result.affectedRows) return fail(res, 404, 'Convite pendente não encontrado');
  res.json({ ok: true });
}));

app.get('/api/invitations/:token', run(async (req, res) => {
  const [rows] = await db().execute('SELECT i.email,i.expires_at,i.accepted_at,p.name AS project_name FROM invitations i JOIN projects p ON p.id=i.project_id WHERE i.token_hash=?', [hash(req.params.token)]);
  if (!rows.length || rows[0].accepted_at || rows[0].expires_at < now()) return fail(res, 404, 'Convite inválido ou expirado');
  res.json({ email: rows[0].email, projectName: rows[0].project_name });
}));

app.post('/api/invitations/:token/accept', run(async (req, res) => {
  const [rows] = await db().execute('SELECT * FROM invitations WHERE token_hash=?', [hash(req.params.token)]);
  const invite = rows[0];
  if (!invite || invite.accepted_at || invite.expires_at < now()) return fail(res, 404, 'Convite inválido ou expirado');
  const [existingUsers] = await db().execute('SELECT id,password_hash FROM users WHERE email=?', [invite.email]);
  const password = String(req.body.password || '');
  if (!existingUsers.length && password.length < 12) return fail(res, 400, 'A senha precisa ter ao menos 12 caracteres');
  if (existingUsers.length && !(await bcrypt.compare(password, existingUsers[0].password_hash))) {
    return fail(res, 401, 'Informe a senha da sua conta para aceitar o convite');
  }
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    let userId = existingUsers[0]?.id;
    if (!userId) {
      userId = randomUUID();
      await connection.execute('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)', [userId, invite.email, await bcrypt.hash(password, 12), now()]);
    }
    await connection.execute('INSERT IGNORE INTO memberships (project_id,user_id,role,created_at) VALUES (?,?,?,?)', [invite.project_id, userId, invite.role, now()]);
    await connection.execute('UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL', [now(), invite.id]);
    await connection.commit();
    await issueSession(req, res, userId);
    res.json({ projectId: invite.project_id });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}));

app.post('/api/projects/:projectId/nodes', requireUser, membership, ownerOnly, run(async (req, res) => {
  const title = text(req.body.title, 255);
  if (!title) return fail(res, 400, 'Informe o título');
  const parentId = req.body.parentId || null;
  if (parentId) {
    const [parents] = await db().execute('SELECT id FROM structure_nodes WHERE id=? AND project_id=? AND archived=0', [parentId, req.params.projectId]);
    if (!parents.length) return fail(res, 400, 'Categoria superior inválida');
  }
  const [order] = await db().execute('SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM structure_nodes WHERE project_id=? AND parent_id <=> ?', [req.params.projectId, parentId]);
  const id = randomUUID();
  await db().execute('INSERT INTO structure_nodes (id,project_id,parent_id,title,sort_order,archived,created_at) VALUES (?,?,?,?,?,?,?)',
    [id, req.params.projectId, parentId, title, order[0].next_order, 0, now()]);
  updateTopicSummaries(req.params.projectId);
  res.status(201).json({ id });
}));

app.patch('/api/projects/:projectId/nodes/:nodeId', requireUser, membership, ownerOnly, run(async (req, res) => {
  const [rows] = await db().execute('SELECT * FROM structure_nodes WHERE id=? AND project_id=?', [req.params.nodeId, req.params.projectId]);
  if (!rows.length) return fail(res, 404, 'Categoria não encontrada');
  const title = req.body.title === undefined ? rows[0].title : text(req.body.title, 255);
  if (!title) return fail(res, 400, 'Informe o título');
  const archived = req.body.archived === undefined ? rows[0].archived : Number(Boolean(req.body.archived));
  await db().execute('UPDATE structure_nodes SET title=?,archived=? WHERE id=?', [title, archived, req.params.nodeId]);
  updateTopicSummaries(req.params.projectId);
  res.json({ ok: true });
}));

const allowedMime = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp']);

async function processSource(sourceId, projectId) {
  const [sourceRows] = await db().execute('SELECT s.*,p.name AS project_name,t.node_id AS target_node_id FROM sources s JOIN projects p ON p.id=s.project_id LEFT JOIN source_targets t ON t.source_id=s.id WHERE s.id=? AND s.project_id=?', [sourceId, projectId]);
  const source = sourceRows[0];
  const [[allNodes], [existingItems]] = await Promise.all([
    db().execute('SELECT id,parent_id,title FROM structure_nodes WHERE project_id=? AND archived=0', [projectId]),
    db().execute(`SELECT id,node_id,title,location,status FROM items WHERE project_id=?${source.target_node_id ? ' AND node_id=?' : ''} ORDER BY updated_at DESC LIMIT 100`, source.target_node_id ? [projectId, source.target_node_id] : [projectId]),
  ]);
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const nodes = source.target_node_id ? [] : allNodes;
  if (source.target_node_id) {
    let current = nodeById.get(source.target_node_id);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      nodes.unshift(current);
      seen.add(current.id);
      current = nodeById.get(current.parent_id);
    }
  }
  try {
    if (source.target_node_id && !nodes.length) throw new Error('O tópico escolhido não está mais disponível');
    let extracted = await extractItems({ source: { projectName: source.project_name, title: source.title, body: source.body, fileData: source.file_data, contentType: source.content_type, fileName: source.file_name }, nodes, existingItems, preferredNodeId: source.target_node_id });
    if (source.target_node_id && !extracted.length) {
      extracted = [{ existingItemId: '', nodeId: source.target_node_id, title: text(source.body.split(/\r?\n/)[0], 120) || `Atualização em ${nodes.at(-1).title}`, summary: text(source.body, 5000), location: '', discipline: '', supplier: '', responsible: '', status: 'informativo', dueDate: '', attention: false, confidence: 0.5, evidence: text(source.body, 2000) }];
    }
    const connection = await db().getConnection();
    try {
      await connection.beginTransaction();
      const createdByKey = new Map();
      const normalized = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      for (const entry of extracted) {
        const stamp = now();
        const key = [entry.nodeId || '', normalized(entry.title), normalized(entry.location), normalized(entry.discipline)].join('|');
        let itemId = entry.existingItemId || createdByKey.get(key);
        let previousStatus = null;
        if (itemId) {
          const [oldRows] = await connection.execute('SELECT * FROM items WHERE id=? AND project_id=? FOR UPDATE', [itemId, projectId]);
          const old = oldRows[0];
          if (!old) itemId = '';
          else {
            const [locks] = await connection.execute('SELECT title_locked,node_locked FROM item_organization WHERE item_id=? AND project_id=?', [itemId, projectId]);
            const lock = locks[0] || {};
            previousStatus = old.status;
            await connection.execute(`UPDATE items SET node_id=?,title=?,summary=?,location=?,discipline=?,supplier=?,responsible=?,status=?,due_date=?,attention=?,confidence=?,latest_source_id=?,updated_at=? WHERE id=?`,
              [lock.node_locked ? old.node_id : entry.nodeId || old.node_id, lock.title_locked ? old.title : entry.title || old.title, entry.summary || old.summary, entry.location || old.location, entry.discipline || old.discipline, entry.supplier || old.supplier, entry.responsible || old.responsible, entry.status === 'informativo' ? old.status : entry.status, entry.dueDate || old.due_date, Number(entry.attention), entry.confidence, sourceId, stamp, itemId]);
          }
        }
        if (!itemId) {
          itemId = randomUUID();
          await connection.execute(`INSERT INTO items (id,project_id,node_id,title,summary,location,discipline,supplier,responsible,status,due_date,attention,confidence,latest_source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [itemId, projectId, entry.nodeId, entry.title, entry.summary, entry.location, entry.discipline, entry.supplier, entry.responsible, entry.status, entry.dueDate, Number(entry.attention), entry.confidence, sourceId, stamp, stamp]);
        }
        createdByKey.set(key, itemId);
        await connection.execute('INSERT INTO item_updates (id,item_id,source_id,author_id,summary,evidence,previous_status,new_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [randomUUID(), itemId, sourceId, source.author_id, entry.summary, entry.evidence, previousStatus, entry.status, stamp]);
      }
      await connection.execute('UPDATE sources SET analysis_status=?,analysis_error=NULL WHERE id=?', ['completed', sourceId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    updateTopicSummaries(projectId);
    return { extractedCount: extracted.length, status: 'completed' };
  } catch (error) {
    const status = !process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY ? 'needs_key' : 'failed';
    await db().execute('UPDATE sources SET analysis_status=?,analysis_error=? WHERE id=?', [status, error.message.slice(0, 1000), sourceId]);
    return { extractedCount: 0, status, error: error.message };
  }
}

const activeSources = new Map();
let sourceQueue = Promise.resolve();

function startSourceProcessing(sourceId, projectId) {
  if (activeSources.has(sourceId)) return activeSources.get(sourceId);
  const task = sourceQueue.then(async () => {
    await db().execute('UPDATE sources SET analysis_status=?,analysis_error=NULL WHERE id=? AND project_id=?', ['processing', sourceId, projectId]);
    return processSource(sourceId, projectId);
  }).catch(async (error) => {
    console.error('Falha no processamento da fonte:', error);
    try {
      await db().execute('UPDATE sources SET analysis_status=?,analysis_error=? WHERE id=? AND project_id=?', ['failed', String(error.message || error).slice(0, 1000), sourceId, projectId]);
    } catch (databaseError) { console.error('Falha ao registrar erro da fonte:', databaseError); }
    return { status: 'failed', extractedCount: 0 };
  }).finally(() => activeSources.delete(sourceId));
  activeSources.set(sourceId, task);
  sourceQueue = task.then(() => undefined);
  return task;
}

app.post('/api/projects/:projectId/sources', requireUser, membership, run(async (req, res) => {
  const title = text(req.body.title, 255) || 'Nova informação';
  const body = text(req.body.body, MAX_SOURCE_TEXT + 1);
  if (body.length > MAX_SOURCE_TEXT) return fail(res, 400, 'A mensagem é extensa demais. Divida-a em partes menores.');
  let fileData = null;
  let contentType = null;
  let fileName = null;
  if (req.body.fileData) {
    contentType = text(req.body.contentType, 120);
    fileName = text(req.body.fileName, 255);
    if (!allowedMime.has(contentType)) return fail(res, 400, 'Tipo de arquivo não aceito neste MVP');
    fileData = Buffer.from(String(req.body.fileData), 'base64');
    if (!fileData.length || fileData.length > 5 * 1024 * 1024) return fail(res, 400, 'O arquivo deve ter até 5 MB');
  }
  if (!body && !fileData) return fail(res, 400, 'Cole um texto ou selecione um arquivo');
  const id = randomUUID();
  await db().execute('INSERT INTO sources (id,project_id,author_id,title,kind,body,file_name,content_type,file_data,analysis_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, req.params.projectId, req.user.id, title, fileData ? 'file' : 'text', body, fileName, contentType, fileData, 'pending', now()]);
  if (fileData) {
    void startSourceProcessing(id, req.params.projectId);
    return res.status(202).json({ id, status: 'processing', extractedCount: 0 });
  }
  const analysis = await processSource(id, req.params.projectId);
  res.status(201).json({ id, ...analysis });
}));

app.post('/api/projects/:projectId/nodes/:nodeId/updates', requireUser, membership, run(async (req, res) => {
  const body = text(req.body.body, MAX_SOURCE_TEXT + 1);
  if (!body) return fail(res, 400, 'Escreva a atualização antes de enviar');
  if (body.length > MAX_SOURCE_TEXT) return fail(res, 400, 'A mensagem é extensa demais. Divida-a em partes menores.');
  const [nodes] = await db().execute('SELECT id,title FROM structure_nodes WHERE id=? AND project_id=? AND archived=0', [req.params.nodeId, req.params.projectId]);
  if (!nodes.length) return fail(res, 404, 'Tópico não encontrado');
  const sourceId = randomUUID();
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO sources (id,project_id,author_id,title,kind,body,analysis_status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [sourceId, req.params.projectId, req.user.id, `Atualização: ${nodes[0].title}`.slice(0, 255), 'topic_note', body, 'pending', now()]);
    await connection.execute('INSERT INTO source_targets (source_id,project_id,node_id) VALUES (?,?,?)',
      [sourceId, req.params.projectId, req.params.nodeId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  void startSourceProcessing(sourceId, req.params.projectId);
  res.status(202).json({ id: sourceId, status: 'processing' });
}));

app.post('/api/projects/:projectId/sources/:sourceId/reprocess', requireUser, membership, run(async (req, res) => {
  const [rows] = await db().execute('SELECT id,analysis_status FROM sources WHERE id=? AND project_id=?', [req.params.sourceId, req.params.projectId]);
  if (!rows.length) return fail(res, 404, 'Fonte não encontrada');
  if (rows[0].analysis_status === 'completed') return fail(res, 409, 'Esta fonte já foi analisada');
  if (activeSources.has(req.params.sourceId)) return res.json({ status: 'processing' });
  void startSourceProcessing(req.params.sourceId, req.params.projectId);
  res.json({ status: 'processing' });
}));

app.get('/api/projects/:projectId/sources/:sourceId/file', requireUser, membership, run(async (req, res) => {
  const [rows] = await db().execute('SELECT file_name,content_type,file_data FROM sources WHERE id=? AND project_id=?', [req.params.sourceId, req.params.projectId]);
  if (!rows.length || !rows[0].file_data) return fail(res, 404, 'Arquivo não encontrado');
  res.setHeader('Content-Type', rows[0].content_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`);
  res.send(rows[0].file_data);
}));

app.post('/api/projects/:projectId/items', requireUser, membership, run(async (req, res) => {
  const title = text(req.body.title, 255);
  if (!title) return fail(res, 400, 'Informe o assunto');
  const summary = text(req.body.summary, 5000);
  let nodeId = req.body.nodeId || null;
  let classification = 'chosen';
  if (nodeId) {
    const [nodes] = await db().execute('SELECT id FROM structure_nodes WHERE id=? AND project_id=? AND archived=0', [nodeId, req.params.projectId]);
    if (!nodes.length) return fail(res, 400, 'Categoria inválida');
  } else {
    classification = 'needs_confirmation';
    const [nodes] = await db().execute('SELECT id,parent_id,title FROM structure_nodes WHERE project_id=? AND archived=0', [req.params.projectId]);
    if (nodes.length && (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY)) {
      try {
        const result = await classifyNode({ title, summary, location: text(req.body.location, 160), discipline: text(req.body.discipline, 160), nodes });
        if (result.nodeId) {
          nodeId = result.nodeId;
          classification = 'automatic';
        }
      } catch (error) {
        console.error('Falha ao classificar registro manual:', error);
      }
    }
  }
  const sourceId = randomUUID();
  const itemId = randomUUID();
  const stamp = now();
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO sources (id,project_id,author_id,title,kind,body,analysis_status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [sourceId, req.params.projectId, req.user.id, `Registro manual: ${title}`, 'manual', summary, 'manual', stamp]);
    await connection.execute('INSERT INTO items (id,project_id,node_id,title,summary,location,discipline,supplier,responsible,status,due_date,attention,confidence,latest_source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [itemId, req.params.projectId, nodeId, title, summary, text(req.body.location, 160), text(req.body.discipline, 160), text(req.body.supplier, 160), text(req.body.responsible, 160), ['pendente','em_andamento','bloqueado','concluido','informativo'].includes(req.body.status) ? req.body.status : 'pendente', /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate) ? req.body.dueDate : '', Number(Boolean(req.body.attention)), 1, sourceId, stamp, stamp]);
    await connection.execute('INSERT INTO item_updates (id,item_id,source_id,author_id,summary,evidence,previous_status,new_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [randomUUID(), itemId, sourceId, req.user.id, summary, summary, null, req.body.status || 'pendente', stamp]);
    await connection.commit();
    updateTopicSummaries(req.params.projectId);
    res.status(201).json({ id: itemId, classification });
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}));

app.patch('/api/projects/:projectId/items/:itemId/category', requireUser, membership, run(async (req, res) => {
  const nodeId = text(req.body.nodeId, 36);
  if (!nodeId) return fail(res, 400, 'Escolha um tópico');
  const [[items], [nodes]] = await Promise.all([
    db().execute('SELECT id,node_id FROM items WHERE id=? AND project_id=?', [req.params.itemId, req.params.projectId]),
    db().execute('SELECT id FROM structure_nodes WHERE id=? AND project_id=? AND archived=0', [nodeId, req.params.projectId]),
  ]);
  if (!items.length) return fail(res, 404, 'Assunto não encontrado');
  if (!nodes.length) return fail(res, 400, 'Tópico inválido');
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE items SET node_id=?,updated_at=? WHERE id=? AND project_id=?', [nodeId, now(), req.params.itemId, req.params.projectId]);
    await lockOrganization(connection, req.params.projectId, req.params.itemId, false, nodeId !== items[0].node_id);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  updateTopicSummaries(req.params.projectId);
  res.json({ ok: true });
}));

app.get('/api/projects/:projectId/sources/:sourceId/review', requireUser, membership, run(async (req, res) => {
  const [sources] = await db().execute('SELECT id FROM sources WHERE id=? AND project_id=?', [req.params.sourceId, req.params.projectId]);
  if (!sources.length) return fail(res, 404, 'Fonte não encontrada');
  const [rows] = await db().execute(`SELECT i.id,i.node_id,i.title,i.summary,i.location,i.discipline,i.supplier,i.responsible,i.status,i.due_date,i.attention,i.confidence,i.latest_source_id,i.created_at,i.updated_at,
      u.id AS update_id,u.summary AS source_summary,u.evidence AS source_evidence,u.created_at AS source_update_at
    FROM item_updates u JOIN items i ON i.id=u.item_id
    WHERE u.source_id=? AND i.project_id=? ORDER BY u.created_at,u.id`, [req.params.sourceId, req.params.projectId]);
  const byItem = new Map();
  for (const row of rows) {
    if (!byItem.has(row.id)) byItem.set(row.id, { item: { id: row.id, node_id: row.node_id, title: row.title, summary: row.summary, location: row.location, discipline: row.discipline, supplier: row.supplier, responsible: row.responsible, status: row.status, due_date: row.due_date, attention: row.attention, confidence: row.confidence, created_at: row.created_at, updated_at: row.updated_at }, excerpts: [] });
    byItem.get(row.id).excerpts.push({ id: row.update_id, summary: row.source_summary, evidence: row.source_evidence, created_at: row.source_update_at });
  }
  res.json({ entries: [...byItem.values()] });
}));

app.patch('/api/projects/:projectId/items/organize', requireUser, membership, run(async (req, res) => {
  const changes = req.body.changes;
  if (!Array.isArray(changes) || !changes.length || changes.length > 500) return fail(res, 400, 'Envie de 1 a 500 assuntos por vez');
  if (changes.some((change) => !change || typeof change !== 'object')) return fail(res, 400, 'Há assuntos inválidos na revisão');
  if (new Set(changes.map((change) => change.id)).size !== changes.length) return fail(res, 400, 'Há assuntos repetidos na revisão');
  const ids = changes.map((change) => text(change.id, 36));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return fail(res, 400, 'Há assuntos inválidos ou repetidos na revisão');
  const [items] = await db().execute(`SELECT id,node_id,title,updated_at FROM items WHERE project_id=? AND id IN (${ids.map(() => '?').join(',')})`, [req.params.projectId, ...ids]);
  if (items.length !== ids.length) return fail(res, 404, 'Um dos assuntos não foi encontrado');
  const existing = new Map(items.map((item) => [item.id, item]));
  const [nodes] = await db().execute('SELECT id FROM structure_nodes WHERE project_id=? AND archived=0', [req.params.projectId]);
  const validNodes = new Set(nodes.map((node) => node.id));
  const cleaned = [];
  for (const change of changes) {
    const id = text(change.id, 36);
    const title = text(change.title, 255);
    const nodeId = change.nodeId ? text(change.nodeId, 36) : null;
    if (!title || title.length < 3) return fail(res, 400, 'Cada assunto precisa de um título com pelo menos 3 caracteres');
    if (nodeId && !validNodes.has(nodeId) && existing.get(id).node_id !== nodeId) return fail(res, 400, 'Um dos tópicos escolhidos não existe mais');
    if (!change.expectedUpdatedAt || existing.get(id).updated_at !== change.expectedUpdatedAt) return fail(res, 409, 'Um assunto mudou durante a revisão. Atualize a lista antes de salvar.');
    cleaned.push({ id, title, nodeId, expectedUpdatedAt: change.expectedUpdatedAt, lockTitle: title !== existing.get(id).title, lockNode: nodeId !== existing.get(id).node_id });
  }
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    for (const change of cleaned) {
      const stamp = new Date(Math.max(Date.now(), Date.parse(change.expectedUpdatedAt) + 1)).toISOString();
      const [result] = await connection.execute('UPDATE items SET title=?,node_id=?,updated_at=? WHERE id=? AND project_id=? AND updated_at=?',
        [change.title, change.nodeId, stamp, change.id, req.params.projectId, change.expectedUpdatedAt]);
      if (result.affectedRows !== 1) { const error = new Error('Um assunto mudou durante a revisão. Atualize a lista antes de salvar.'); error.status = 409; throw error; }
      await lockOrganization(connection, req.params.projectId, change.id, change.lockTitle, change.lockNode);
    }
    await connection.commit();
    updateTopicSummaries(req.params.projectId);
    res.json({ ok: true, updated: cleaned.length });
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}));

app.post('/api/projects/:projectId/items/:itemId/category/suggest', requireUser, membership, run(async (req, res) => {
  const [[items], [nodes]] = await Promise.all([
    db().execute('SELECT id,node_id,title,summary,location,discipline FROM items WHERE id=? AND project_id=?', [req.params.itemId, req.params.projectId]),
    db().execute('SELECT id,parent_id,title FROM structure_nodes WHERE project_id=? AND archived=0', [req.params.projectId]),
  ]);
  if (!items.length) return fail(res, 404, 'Assunto não encontrado');
  if (!nodes.length) return fail(res, 400, 'Crie um tópico na estrutura antes de classificar');
  const result = await classifyNode({ ...items[0], nodes });
  if (!result.nodeId) return res.json({ classification: 'needs_confirmation' });
  const [locks] = await db().execute('SELECT node_locked FROM item_organization WHERE item_id=? AND project_id=?', [req.params.itemId, req.params.projectId]);
  if (locks[0]?.node_locked) return res.json({ classification: 'manual' });
  await db().execute('UPDATE items SET node_id=? WHERE id=? AND project_id=?', [result.nodeId, req.params.itemId, req.params.projectId]);
  updateTopicSummaries(req.params.projectId);
  res.json({ classification: 'automatic' });
}));

app.patch('/api/projects/:projectId/items/:itemId', requireUser, membership, run(async (req, res) => {
  const [rows] = await db().execute('SELECT * FROM items WHERE id=? AND project_id=?', [req.params.itemId, req.params.projectId]);
  if (!rows.length) return fail(res, 404, 'Assunto não encontrado');
  const old = rows[0];
  const status = ['pendente','em_andamento','bloqueado','concluido','informativo'].includes(req.body.status) ? req.body.status : old.status;
  const summary = req.body.summary === undefined ? old.summary : text(req.body.summary, 5000);
  const responsible = req.body.responsible === undefined ? old.responsible : text(req.body.responsible, 160);
  const supplier = req.body.supplier === undefined ? old.supplier : text(req.body.supplier, 160);
  const dueDate = req.body.dueDate === undefined ? old.due_date : (/^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate) ? req.body.dueDate : '');
  const attention = req.body.attention === undefined ? old.attention : Number(Boolean(req.body.attention));
  const nodeId = req.body.nodeId === undefined ? old.node_id : text(req.body.nodeId, 36) || null;
  if (nodeId) {
    const [nodes] = await db().execute('SELECT id FROM structure_nodes WHERE id=? AND project_id=? AND archived=0', [nodeId, req.params.projectId]);
    if (!nodes.length) return fail(res, 400, 'Tópico inválido');
  }
  const stamp = now();
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE items SET node_id=?,summary=?,responsible=?,supplier=?,status=?,due_date=?,attention=?,updated_at=? WHERE id=?', [nodeId, summary, responsible, supplier, status, dueDate, attention, stamp, old.id]);
    await lockOrganization(connection, req.params.projectId, old.id, false, nodeId !== old.node_id);
    await connection.execute('INSERT INTO item_updates (id,item_id,source_id,author_id,summary,evidence,previous_status,new_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [randomUUID(), old.id, null, req.user.id, text(req.body.note, 2000) || 'Atualização manual', '', old.status, status, stamp]);
    await connection.commit();
    updateTopicSummaries(req.params.projectId);
    res.json({ ok: true });
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}));

app.get('/api/projects/:projectId/items/:itemId/updates', requireUser, membership, run(async (req, res) => {
  const [items] = await db().execute('SELECT id FROM items WHERE id=? AND project_id=?', [req.params.itemId, req.params.projectId]);
  if (!items.length) return fail(res, 404, 'Assunto não encontrado');
  const [updates] = await db().execute('SELECT u.*,s.title AS source_title,a.email AS author_email FROM item_updates u LEFT JOIN sources s ON s.id=u.source_id LEFT JOIN users a ON a.id=u.author_id WHERE u.item_id=? ORDER BY u.created_at DESC,u.id DESC', [req.params.itemId]);
  res.json({ updates });
}));

app.get('/api/projects/:projectId/history', requireUser, membership, run(async (req, res) => {
  const [updates] = await db().execute(`SELECT u.id,u.item_id,u.summary,u.evidence,u.created_at,
      s.title AS source_title,a.email AS author_email
    FROM item_updates u JOIN items i ON i.id=u.item_id
    LEFT JOIN sources s ON s.id=u.source_id
    LEFT JOIN users a ON a.id=u.author_id
    WHERE i.project_id=? ORDER BY u.item_id,u.created_at DESC,u.id DESC`, [req.params.projectId]);
  res.json({ updates });
}));

app.get('/health', async (_req, res) => {
  try { await db().query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

const root = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(root, '..', 'dist'), { index: false }));
app.get('*', (_req, res) => res.sendFile(join(root, '..', 'dist', 'index.html')));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.type === 'entity.too.large') return fail(res, 413, 'Arquivo ou mensagem muito grande');
  if (error.status === 409) return fail(res, 409, error.message);
  return fail(res, 500, 'Não foi possível concluir a operação');
});

await initializeDatabase();
const [unfinishedSources] = await db().execute("SELECT id,project_id FROM sources WHERE analysis_status IN ('pending','processing') ORDER BY created_at");
for (const source of unfinishedSources) void startSourceProcessing(source.id, source.project_id);
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(`Organizador disponível na porta ${port}`));
