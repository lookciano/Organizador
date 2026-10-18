import express from 'express';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, createProject, initializeDatabase } from './db.mjs';
import { extractItems } from './ai.mjs';

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
    db().execute(`SELECT i.*,s.title AS source_title,
      latest.summary AS latest_update,latest.created_at AS latest_update_at,
      author.email AS latest_update_author,COALESCE(latest.update_count,0) AS update_count
      FROM items i
      LEFT JOIN sources s ON s.id=i.latest_source_id
      LEFT JOIN (
        SELECT u.item_id,u.summary,u.created_at,u.author_id,
          COUNT(*) OVER (PARTITION BY u.item_id) AS update_count,
          ROW_NUMBER() OVER (PARTITION BY u.item_id ORDER BY u.created_at DESC,u.id DESC) AS history_rank
        FROM item_updates u JOIN items scoped ON scoped.id=u.item_id
        WHERE scoped.project_id=?
      ) latest ON latest.item_id=i.id AND latest.history_rank=1
      LEFT JOIN users author ON author.id=latest.author_id
      WHERE i.project_id=? ORDER BY i.updated_at DESC LIMIT 500`, [projectId, projectId]),
    db().execute('SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.role,u.email', [projectId]),
    db().execute('SELECT id,email,role,expires_at,accepted_at,created_at FROM invitations WHERE project_id=? ORDER BY created_at DESC LIMIT 100', [projectId]),
  ]);
  res.json({ user: req.user, projects, project, nodes, sources, items, members, invitations });
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
  const id = randomUUID();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await db().execute('INSERT INTO invitations (id,project_id,email,role,token_hash,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, req.params.projectId, email, 'member', hash(token), req.user.id, expires, now()]);
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
  res.status(201).json({ id, emailed, inviteUrl: emailed ? undefined : inviteUrl });
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
  res.status(201).json({ id });
}));

app.patch('/api/projects/:projectId/nodes/:nodeId', requireUser, membership, ownerOnly, run(async (req, res) => {
  const [rows] = await db().execute('SELECT * FROM structure_nodes WHERE id=? AND project_id=?', [req.params.nodeId, req.params.projectId]);
  if (!rows.length) return fail(res, 404, 'Categoria não encontrada');
  const title = req.body.title === undefined ? rows[0].title : text(req.body.title, 255);
  if (!title) return fail(res, 400, 'Informe o título');
  const archived = req.body.archived === undefined ? rows[0].archived : Number(Boolean(req.body.archived));
  await db().execute('UPDATE structure_nodes SET title=?,archived=? WHERE id=?', [title, archived, req.params.nodeId]);
  res.json({ ok: true });
}));

const allowedMime = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp']);

async function processSource(sourceId, projectId) {
  const [sourceRows] = await db().execute('SELECT s.*,p.name AS project_name FROM sources s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.project_id=?', [sourceId, projectId]);
  const source = sourceRows[0];
  const [[nodes], [existingItems]] = await Promise.all([
    db().execute('SELECT id,title FROM structure_nodes WHERE project_id=? AND archived=0', [projectId]),
    db().execute('SELECT id,title,location,status FROM items WHERE project_id=? ORDER BY updated_at DESC LIMIT 100', [projectId]),
  ]);
  try {
    const extracted = await extractItems({ source: { projectName: source.project_name, title: source.title, body: source.body, fileData: source.file_data, contentType: source.content_type, fileName: source.file_name }, nodes, existingItems });
    const connection = await db().getConnection();
    try {
      await connection.beginTransaction();
      for (const entry of extracted) {
        const stamp = now();
        let itemId = entry.existingItemId;
        let previousStatus = null;
        if (itemId) {
          const [oldRows] = await connection.execute('SELECT * FROM items WHERE id=? AND project_id=?', [itemId, projectId]);
          const old = oldRows[0];
          if (!old) itemId = '';
          else {
            previousStatus = old.status;
            await connection.execute(`UPDATE items SET node_id=?,title=?,summary=?,location=?,discipline=?,supplier=?,responsible=?,status=?,due_date=?,attention=?,confidence=?,latest_source_id=?,updated_at=? WHERE id=?`,
              [entry.nodeId || old.node_id, entry.title || old.title, entry.summary || old.summary, entry.location || old.location, entry.discipline || old.discipline, entry.supplier || old.supplier, entry.responsible || old.responsible, entry.status === 'informativo' ? old.status : entry.status, entry.dueDate || old.due_date, Number(entry.attention), entry.confidence, sourceId, stamp, itemId]);
          }
        }
        if (!itemId) {
          itemId = randomUUID();
          await connection.execute(`INSERT INTO items (id,project_id,node_id,title,summary,location,discipline,supplier,responsible,status,due_date,attention,confidence,latest_source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [itemId, projectId, entry.nodeId, entry.title, entry.summary, entry.location, entry.discipline, entry.supplier, entry.responsible, entry.status, entry.dueDate, Number(entry.attention), entry.confidence, sourceId, stamp, stamp]);
        }
        await connection.execute('INSERT INTO item_updates (id,item_id,source_id,author_id,summary,evidence,previous_status,new_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [randomUUID(), itemId, sourceId, source.author_id, entry.summary, entry.evidence, previousStatus, entry.status, stamp]);
      }
      await connection.execute('UPDATE sources SET analysis_status=?,analysis_error=NULL WHERE id=?', ['completed', sourceId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return { extractedCount: extracted.length, status: 'completed' };
  } catch (error) {
    const status = !process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY ? 'needs_key' : 'failed';
    await db().execute('UPDATE sources SET analysis_status=?,analysis_error=? WHERE id=?', [status, error.message.slice(0, 1000), sourceId]);
    return { extractedCount: 0, status, error: error.message };
  }
}

app.post('/api/projects/:projectId/sources', requireUser, membership, run(async (req, res) => {
  const title = text(req.body.title, 255) || 'Nova informação';
  const body = text(req.body.body, 60000);
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
  const analysis = await processSource(id, req.params.projectId);
  res.status(201).json({ id, ...analysis });
}));

app.post('/api/projects/:projectId/sources/:sourceId/reprocess', requireUser, membership, run(async (req, res) => {
  const [rows] = await db().execute('SELECT id,analysis_status FROM sources WHERE id=? AND project_id=?', [req.params.sourceId, req.params.projectId]);
  if (!rows.length) return fail(res, 404, 'Fonte não encontrada');
  if (rows[0].analysis_status === 'completed') return fail(res, 409, 'Esta fonte já foi analisada');
  res.json(await processSource(req.params.sourceId, req.params.projectId));
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
  const nodeId = req.body.nodeId || null;
  if (nodeId) {
    const [nodes] = await db().execute('SELECT id FROM structure_nodes WHERE id=? AND project_id=? AND archived=0', [nodeId, req.params.projectId]);
    if (!nodes.length) return fail(res, 400, 'Categoria inválida');
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
    res.status(201).json({ id: itemId });
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
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
  const stamp = now();
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE items SET summary=?,responsible=?,supplier=?,status=?,due_date=?,attention=?,updated_at=? WHERE id=?', [summary, responsible, supplier, status, dueDate, attention, stamp, old.id]);
    await connection.execute('INSERT INTO item_updates (id,item_id,source_id,author_id,summary,evidence,previous_status,new_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [randomUUID(), old.id, null, req.user.id, text(req.body.note, 2000) || 'Atualização manual', '', old.status, status, stamp]);
    await connection.commit();
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

app.get('/api/projects/:projectId/recent-history', requireUser, membership, run(async (req, res) => {
  const [updates] = await db().execute(`SELECT item_id,summary,created_at,source_title FROM (
    SELECT u.item_id,u.summary,u.created_at,s.title AS source_title,
      ROW_NUMBER() OVER (PARTITION BY u.item_id ORDER BY u.created_at DESC,u.id DESC) AS history_rank
    FROM item_updates u JOIN items i ON i.id=u.item_id
    LEFT JOIN sources s ON s.id=u.source_id
    WHERE i.project_id=?
  ) ranked WHERE history_rank BETWEEN 2 AND 3 ORDER BY item_id,history_rank`, [req.params.projectId]);
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
  return fail(res, 500, 'Não foi possível concluir a operação');
});

await initializeDatabase();
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(`Organizador disponível na porta ${port}`));
