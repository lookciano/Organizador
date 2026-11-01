import { createHash } from 'node:crypto';
import { db } from './db.mjs';
import { summarizeExecutive } from './ai.mjs';

const hasModelKey = () => Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
const sourceHash = (summary) => createHash('sha256').update(`executive-v3\n${summary}`).digest('hex');
const active = new Set();
const waiting = [];
let running = 0;

async function generate(nodeId, projectId, hash) {
  const [rows] = await db().execute('SELECT source_hash,analysis_status FROM topic_executive_summaries WHERE node_id=? AND project_id=?', [nodeId, projectId]);
  if (!rows.length || rows[0].source_hash !== hash || !['pending', 'processing'].includes(rows[0].analysis_status)) return;
  await db().execute("UPDATE topic_executive_summaries SET analysis_status='processing' WHERE node_id=? AND project_id=? AND source_hash=? AND analysis_status IN ('pending','processing')", [nodeId, projectId, hash]);
  try {
    const [sources] = await db().execute(`SELECT n.title,s.summary FROM topic_summaries s JOIN structure_nodes n ON n.id=s.node_id
      WHERE s.node_id=? AND s.project_id=? AND s.analysis_status='completed' AND n.parent_id IS NULL AND n.archived=0`, [nodeId, projectId]);
    if (!sources.length || sourceHash(sources[0].summary) !== hash) return;
    const summary = await summarizeExecutive({ topicPath: sources[0].title, synthesis: sources[0].summary,
      onProgress: ({ completed, total }) => console.info('Progresso do resumo executivo:', nodeId, { subestacoesAnalisadas: completed, total }),
    });
    const [saved] = await db().execute(`UPDATE topic_executive_summaries SET summary=?,analysis_status='completed',analysis_error=NULL,generated_at=?
      WHERE node_id=? AND project_id=? AND source_hash=? AND analysis_status='processing'`,
    [summary, new Date().toISOString(), nodeId, projectId, hash]);
    if (saved.affectedRows) console.info('Resumo executivo concluído:', nodeId, { caracteres: summary.length });
  } catch (error) {
    console.error('Falha no resumo executivo:', nodeId, error);
    await db().execute('UPDATE topic_executive_summaries SET analysis_status=?,analysis_error=? WHERE node_id=? AND project_id=? AND source_hash=?',
      [hasModelKey() ? 'failed' : 'needs_key', String(error.message || error).slice(0, 1000), nodeId, projectId, hash]);
  }
}

function schedule(nodeId, projectId, hash) {
  const key = `${projectId}:${nodeId}:${hash}`;
  if (active.has(key)) return;
  active.add(key);
  waiting.push({ key, nodeId, projectId, hash });
  drain();
}

function drain() {
  while (running < 1 && waiting.length) {
    const job = waiting.shift();
    running++;
    void generate(job.nodeId, job.projectId, job.hash)
      .catch((error) => console.error('Falha na fila de resumos executivos:', error))
      .finally(() => {
        running--;
        active.delete(job.key);
        drain();
      });
  }
}

export async function prepareExecutiveSummaries(projectId, nodes, topicSummaries) {
  const roots = nodes.filter((node) => !node.parent_id && !node.archived);
  if (!roots.length) return [];
  const [rows] = await db().execute('SELECT node_id,source_hash,summary,analysis_status,analysis_error,generated_at FROM topic_executive_summaries WHERE project_id=?', [projectId]);
  const existing = new Map(rows.map((row) => [row.node_id, row]));
  const topicByNode = new Map(topicSummaries.map((entry) => [entry.node_id, entry]));
  const result = [];
  const writes = [];
  const jobs = [];
  for (const node of roots) {
    const topic = topicByNode.get(node.id);
    const old = existing.get(node.id);
    if (!topic?.summary) continue;
    if (topic.analysis_status !== 'completed') {
      result.push({ node_id: node.id, summary: old?.summary || '', analysis_status: 'waiting', analysis_error: null, generated_at: old?.generated_at || null });
      continue;
    }
    const hash = sourceHash(topic.summary);
    const changed = !old || old.source_hash !== hash;
    const retryWithKey = old?.analysis_status === 'needs_key' && hasModelKey();
    const status = changed || retryWithKey ? (hasModelKey() ? 'pending' : 'needs_key') : old.analysis_status;
    if (changed || retryWithKey) {
      writes.push(db().execute(`INSERT INTO topic_executive_summaries (node_id,project_id,source_hash,summary,analysis_status) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          analysis_error=IF(source_hash<>VALUES(source_hash) OR analysis_status='needs_key',NULL,analysis_error),
          analysis_status=IF(source_hash<>VALUES(source_hash) OR analysis_status='needs_key',VALUES(analysis_status),analysis_status),
          source_hash=VALUES(source_hash)`,
      [node.id, projectId, hash, old?.summary || '', status]));
    }
    result.push({ node_id: node.id, summary: old?.summary || '', analysis_status: status, analysis_error: status === 'failed' ? old?.analysis_error : null, generated_at: old?.generated_at || null });
    if (hasModelKey() && ['pending', 'processing'].includes(status)) jobs.push({ nodeId: node.id, projectId, hash });
  }
  await Promise.all(writes);
  for (const job of jobs) schedule(job.nodeId, job.projectId, job.hash);
  return result;
}

export async function retryExecutiveSummary(projectId, nodeId) {
  const [sources] = await db().execute(`SELECT s.summary FROM topic_summaries s JOIN structure_nodes n ON n.id=s.node_id
    WHERE s.project_id=? AND s.node_id=? AND s.analysis_status='completed' AND n.parent_id IS NULL AND n.archived=0`, [projectId, nodeId]);
  if (!sources.length || !sources[0].summary) return false;
  const hash = sourceHash(sources[0].summary);
  const status = hasModelKey() ? 'pending' : 'needs_key';
  await db().execute(`INSERT INTO topic_executive_summaries (node_id,project_id,source_hash,summary,analysis_status) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE source_hash=VALUES(source_hash),analysis_status=VALUES(analysis_status),analysis_error=NULL`,
  [nodeId, projectId, hash, '', status]);
  if (hasModelKey()) schedule(nodeId, projectId, hash);
  return true;
}

export async function resumeExecutiveSummaries() {
  const [rows] = await db().execute(`SELECT n.id AS node_id,n.project_id,s.summary,s.analysis_status FROM structure_nodes n
    JOIN topic_summaries s ON s.node_id=n.id AND s.project_id=n.project_id
    WHERE n.parent_id IS NULL AND n.archived=0 AND s.analysis_status='completed'`);
  const byProject = new Map();
  for (const row of rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, { nodes: [], summaries: [] });
    byProject.get(row.project_id).nodes.push({ id: row.node_id, parent_id: null, archived: 0 });
    byProject.get(row.project_id).summaries.push({ node_id: row.node_id, summary: row.summary, analysis_status: row.analysis_status });
  }
  for (const [projectId, group] of byProject) await prepareExecutiveSummaries(projectId, group.nodes, group.summaries);
}
