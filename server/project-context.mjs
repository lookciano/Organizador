import { db } from './db.mjs';

const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const stopwords = new Set(['para', 'com', 'das', 'dos', 'uma', 'por', 'que', 'sobre', 'projeto', 'informacao', 'assunto', 'atualizacao']);
const tokens = (value) => new Set((normalize(value).match(/[a-z0-9]{3,}/g) || []).filter((part) => !stopwords.has(part)));

export async function loadProjectContext(projectId) {
  const [rows] = await db().execute('SELECT id,title,body,extracted_text,created_at FROM project_context_entries WHERE project_id=? AND archived=0 ORDER BY created_at DESC,id DESC', [projectId]);
  return rows;
}

export function selectProjectContext(entries, query, maxChars = 18000) {
  if (!entries?.length) return '';
  const queryTerms = tokens(query);
  const candidates = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const source = [entry.body, entry.extracted_text].filter(Boolean).join('\n\n').trim();
    if (!source) continue;
    const chunks = [];
    for (let start = 0; start < source.length; start += 2400) chunks.push(source.slice(start, start + 2400));
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const terms = tokens(`${entry.title} ${chunk}`);
      let matches = 0;
      for (const term of queryTerms) if (terms.has(term)) matches++;
      const score = matches * 10 + (entryIndex < 3 ? 3 - entryIndex : 0) + (chunkIndex === 0 ? 1 : 0);
      candidates.push({ score, entryIndex, chunkIndex, createdAt: entry.created_at, text: `[Contexto do projeto — ${entry.title} — inserido em ${entry.created_at} — parte ${chunkIndex + 1}/${chunks.length}]\n${chunk}` });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.entryIndex - b.entryIndex || a.chunkIndex - b.chunkIndex);
  const selected = []; let used = 0;
  for (const candidate of candidates) {
    if (used + candidate.text.length + 2 > maxChars) continue;
    selected.push(candidate); used += candidate.text.length + 2;
  }
  return selected.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.entryIndex - b.entryIndex || a.chunkIndex - b.chunkIndex).map((entry) => entry.text).join('\n\n');
}

export async function projectContextWindow(projectId, query, maxChars) {
  return selectProjectContext(await loadProjectContext(projectId), query, maxChars);
}
