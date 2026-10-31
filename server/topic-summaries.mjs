import { createHash } from 'node:crypto';
import { db } from './db.mjs';
import { structurePaths, summarizeTopicHistory } from './ai.mjs';
import { loadProjectContext, selectProjectContext } from './project-context.mjs';

const hasModelKey = () => Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
const SUMMARY_VERSION = 7;
const MAIN_SECTION_SUMMARY_VERSION = 9;
const MAX_CONCURRENT_SUMMARIES = 2;
const active = new Set();
const waiting = [];
let running = 0;

function relatedItems(nodes, items) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map(nodes.map((node) => [node.id, []]));
  for (const item of items) {
    const visited = new Set();
    let node = byId.get(item.node_id);
    while (node && !visited.has(node.id)) {
      groups.get(node.id).push(item);
      visited.add(node.id);
      node = byId.get(node.parent_id);
    }
  }
  return groups;
}

function contextQuery(path, items) {
  return [path, ...items.flatMap((item) => [item.title, item.summary, item.location, item.discipline, item.supplier, item.responsible])].filter(Boolean).join(' ');
}

function fingerprint(topicPath, items, isMainSection = false, paths = new Map(), projectContext = '') {
  const records = items.map((item) => [item.id, item.node_id, ...(isMainSection ? [paths.get(item.node_id) || ''] : []), item.title, item.summary, item.status, item.responsible, item.supplier, item.due_date, item.attention, item.updated_at, item.update_count || 0]);
  records.sort((a, b) => a[0].localeCompare(b[0]));
  const input = [isMainSection ? MAIN_SECTION_SUMMARY_VERSION : SUMMARY_VERSION, topicPath, records];
  if (projectContext) input.push(createHash('sha256').update(projectContext).digest('hex'));
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function generate(nodeId, projectId, revision) {
  const [rows] = await db().execute('SELECT revision,analysis_status FROM topic_summaries WHERE node_id=? AND project_id=?', [nodeId, projectId]);
  if (!rows.length || rows[0].revision !== revision || !['pending', 'processing'].includes(rows[0].analysis_status)) return;
  await db().execute("UPDATE topic_summaries SET analysis_status=? WHERE node_id=? AND revision=? AND analysis_status IN ('pending','processing')", ['processing', nodeId, revision]);
  const started = Date.now();
  try {
    const [[projects], [nodes]] = await Promise.all([
      db().execute('SELECT name FROM projects WHERE id=?', [projectId]),
      db().execute('SELECT id,parent_id,title FROM structure_nodes WHERE project_id=? AND archived=0', [projectId]),
    ]);
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!projects.length || !node) return;
    const descendants = new Set([nodeId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const entry of nodes) if (entry.parent_id && descendants.has(entry.parent_id) && !descendants.has(entry.id)) {
        descendants.add(entry.id);
        expanded = true;
      }
    }
    const ids = [...descendants];
    const placeholders = ids.map(() => '?').join(',');
    const [items] = await db().execute(`SELECT * FROM items WHERE project_id=? AND node_id IN (${placeholders}) ORDER BY title`, [projectId, ...ids]);
    const updates = [];
    for (let start = 0; start < items.length; start += 400) {
      const batch = items.slice(start, start + 400).map((item) => item.id);
      const marks = batch.map(() => '?').join(',');
      const [rows] = await db().execute(`SELECT u.id,u.item_id,u.summary,u.evidence,u.new_status,u.created_at,s.title AS source_title FROM item_updates u LEFT JOIN sources s ON s.id=u.source_id WHERE u.item_id IN (${marks})`, batch);
      updates.push(...rows);
    }
    const paths = new Map(structurePaths(nodes).map((entry) => [entry.id, entry.path]));
    const path = paths.get(nodeId) || node.title;
    for (const item of items) item.node_path = paths.get(item.node_id) || '';
    const [[priorSummaries], contextEntries] = await Promise.all([
      db().execute('SELECT revision,summary,generated_at FROM topic_summary_history WHERE node_id=? AND project_id=? AND revision<>? ORDER BY generated_at,revision', [nodeId, projectId, revision]),
      loadProjectContext(projectId),
    ]);
    const projectContext = selectProjectContext(contextEntries, contextQuery(path, items));
    const model = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash' : process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    console.info('Iniciando síntese:', nodeId, { modelo: model, assuntos: items.length, registros: updates.length, sintesesAnteriores: priorSummaries.length });
    const result = await summarizeTopicHistory({ projectName: projects[0].name, topicPath: path, items, updates, priorSummaries, isMainSection: !node.parent_id, projectContext });
    const generatedAt = new Date().toISOString();
    const connection = await db().getConnection();
    try {
      await connection.beginTransaction();
      const [saved] = await connection.execute("UPDATE topic_summaries SET summary=?,important_change=?,analysis_status='completed',analysis_error=NULL,generated_at=? WHERE node_id=? AND project_id=? AND revision=? AND analysis_status='processing'",
        [result.summary, result.importantChange, generatedAt, nodeId, projectId, revision]);
      if (saved.affectedRows) await connection.execute('INSERT IGNORE INTO topic_summary_history (node_id,project_id,revision,summary,important_change,generated_at) VALUES (?,?,?,?,?,?)',
        [nodeId, projectId, revision, result.summary, result.importantChange, generatedAt]);
      await connection.commit();
      console.info('Síntese concluída:', nodeId, { segundos: Math.round((Date.now() - started) / 1000), assuntos: items.length });
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  } catch (error) {
    console.error('Falha ao sintetizar tópico:', nodeId, error);
    const status = hasModelKey() ? 'failed' : 'needs_key';
    await db().execute('UPDATE topic_summaries SET analysis_status=?,analysis_error=? WHERE node_id=? AND project_id=? AND revision=?',
      [status, String(error.message || error).slice(0, 1000), nodeId, projectId, revision]);
  }
}

function schedule(nodeId, projectId, revision) {
  const key = `${projectId}:${nodeId}:${revision}`;
  if (active.has(key)) return;
  active.add(key);
  waiting.push({ key, nodeId, projectId, revision });
  drain();
}

function drain() {
  while (running < MAX_CONCURRENT_SUMMARIES && waiting.length) {
    const job = waiting.shift();
    running++;
    void generate(job.nodeId, job.projectId, job.revision)
      .catch((error) => console.error('Falha na fila de sínteses:', error))
      .finally(() => {
        running--;
        active.delete(job.key);
        drain();
      });
  }
}

export async function prepareTopicSummaries(projectId, nodes, items) {
  const activeNodes = nodes.filter((node) => !node.archived);
  const paths = new Map(structurePaths(activeNodes).map((node) => [node.id, node.path]));
  const groups = relatedItems(activeNodes, items);
  const [[rows], contextEntries] = await Promise.all([
    db().execute('SELECT node_id,revision,summary,important_change,analysis_status,analysis_error,generated_at FROM topic_summaries WHERE project_id=?', [projectId]),
    loadProjectContext(projectId),
  ]);
  const existing = new Map(rows.map((row) => [row.node_id, row]));
  const result = [];
  const writes = [];
  const jobs = [];
  for (const node of activeNodes) {
    const records = groups.get(node.id) || [];
    if (!records.length) {
      const old = existing.get(node.id);
      if (old?.summary && old.analysis_status === 'completed' && old.generated_at) {
        writes.push(db().execute('INSERT IGNORE INTO topic_summary_history (node_id,project_id,revision,summary,important_change,generated_at) VALUES (?,?,?,?,?,?)',
          [node.id, projectId, old.revision, old.summary, old.important_change || '', old.generated_at]));
      }
      if (old) writes.push(db().execute('DELETE FROM topic_summaries WHERE node_id=? AND project_id=?', [node.id, projectId]));
      continue;
    }
    const topicPath = paths.get(node.id) || node.title;
    const projectContext = selectProjectContext(contextEntries, contextQuery(topicPath, records));
    const revision = fingerprint(topicPath, records, !node.parent_id, paths, projectContext);
    const old = existing.get(node.id);
    const retryWithKey = old?.analysis_status === 'needs_key' && hasModelKey();
    const initialStatus = hasModelKey() ? 'pending' : 'needs_key';
    if (!old || old.revision !== revision || retryWithKey) {
      if (old?.summary && old.analysis_status === 'completed' && old.generated_at) {
        writes.push(db().execute('INSERT IGNORE INTO topic_summary_history (node_id,project_id,revision,summary,important_change,generated_at) VALUES (?,?,?,?,?,?)',
          [node.id, projectId, old.revision, old.summary, old.important_change || '', old.generated_at]));
      }
      writes.push(db().execute(`INSERT INTO topic_summaries (node_id,project_id,revision,summary,important_change,analysis_status) VALUES (?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          analysis_error=IF(revision<>VALUES(revision) OR analysis_status='needs_key',NULL,analysis_error),
          analysis_status=IF(revision<>VALUES(revision) OR analysis_status='needs_key',VALUES(analysis_status),analysis_status),
          revision=VALUES(revision)`,
        [node.id, projectId, revision, old?.summary || '', old?.important_change || '', initialStatus]));
    }
    const status = !old || old.revision !== revision || retryWithKey ? initialStatus : old.analysis_status;
    const current = { node_id: node.id, summary: old?.summary || '', important_change: status === 'completed' ? old?.important_change || '' : '', analysis_status: status, analysis_error: status === 'failed' ? old?.analysis_error : null, generated_at: old?.generated_at || null };
    result.push(current);
    if (hasModelKey() && ['pending', 'processing'].includes(status)) {
      const work = records.reduce((total, item) => total + Number(item.update_count || 0) + 1, 0);
      jobs.push({ nodeId: node.id, projectId, revision, work });
    }
  }
  await Promise.all(writes);
  jobs.sort((a, b) => a.work - b.work);
  for (const job of jobs) schedule(job.nodeId, job.projectId, job.revision);
  return result;
}

export async function refreshTopicSummariesForProject(projectId) {
  const [[nodes], [items], [counts]] = await Promise.all([
    db().execute('SELECT id,parent_id,title,archived FROM structure_nodes WHERE project_id=?', [projectId]),
    db().execute('SELECT * FROM items WHERE project_id=?', [projectId]),
    db().execute('SELECT u.item_id,COUNT(*) AS update_count FROM item_updates u JOIN items i ON i.id=u.item_id WHERE i.project_id=? GROUP BY u.item_id', [projectId]),
  ]);
  const byId = new Map(counts.map((row) => [row.item_id, Number(row.update_count)]));
  for (const item of items) item.update_count = byId.get(item.id) || 0;
  return prepareTopicSummaries(projectId, nodes, items);
}

export async function retryTopicSummary(projectId, nodeId) {
  const [rows] = await db().execute('SELECT revision FROM topic_summaries WHERE node_id=? AND project_id=?', [nodeId, projectId]);
  if (!rows.length) return false;
  await db().execute('UPDATE topic_summaries SET analysis_status=?,analysis_error=NULL WHERE node_id=? AND project_id=?', [hasModelKey() ? 'pending' : 'needs_key', nodeId, projectId]);
  if (hasModelKey()) schedule(nodeId, projectId, rows[0].revision);
  return true;
}
