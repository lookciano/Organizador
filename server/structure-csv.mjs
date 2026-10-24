import { createHash } from 'node:crypto';

const headers = ['codigo', 'id', 'codigo_pai', 'titulo', 'ordem', 'arquivado', 'caminho_atual'];
const error = (message) => { const value = new Error(message); value.status = 400; return value; };

function ordered(nodes) {
  const children = new Map();
  for (const node of nodes) {
    const key = node.parent_id || '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  for (const values of children.values()) values.sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || a.title.localeCompare(b.title, 'pt-BR'));
  const result = [];
  const seen = new Set();
  function visit(parent, path) {
    for (const node of children.get(parent) || []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      result.push({ ...node, path: [...path, node.title].join(' > ') });
      visit(node.id, [...path, node.title]);
    }
  }
  visit('', []);
  for (const node of nodes) if (!seen.has(node.id)) { result.push({ ...node, path: node.title }); seen.add(node.id); }
  return result;
}

function cell(value) {
  const content = String(value ?? '');
  return /[;"\r\n]/.test(content) ? `"${content.replaceAll('"', '""')}"` : content;
}

export function exportStructureCsv(nodes) {
  const rows = ordered(nodes);
  const codes = new Map(rows.map((node, index) => [node.id, `N${String(index + 1).padStart(3, '0')}`]));
  return '\ufeff' + [headers, ...rows.map((node) => [codes.get(node.id), node.id, codes.get(node.parent_id) || '', node.title, node.sort_order, Number(node.archived), node.path])]
    .map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

function parseCsv(content) {
  const input = content.replace(/^\ufeff/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') {
      if (field) throw error('Aspas inválidas na planilha');
      quoted = true;
    } else if (character === ';') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index++;
      row.push(field); if (row.some((value) => value !== '')) rows.push(row);
      row = []; field = '';
    } else field += character;
  }
  if (quoted) throw error('Aspas não fechadas na planilha');
  row.push(field); if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

export function structureRevision(nodes) {
  return createHash('sha256').update(JSON.stringify(nodes.map((node) => [node.id, node.parent_id, node.title, Number(node.sort_order), Number(node.archived)]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

export function planStructureImport(csv, existing) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 1024 * 1024) throw error('A planilha deve ter até 1 MB');
  const rows = parseCsv(csv);
  if (!rows.length || headers.some((header, index) => rows[0][index]?.trim() !== header)) throw error(`Cabeçalho inválido. Exporte a estrutura atual e edite essa planilha; mantenha as colunas ${headers.join(', ')}.`);
  if (rows.length > 2001) throw error('A planilha pode conter até 2.000 categorias');
  const byId = new Map(existing.map((node) => [node.id, node]));
  const byCode = new Map(); const seenIds = new Set();
  const parsed = rows.slice(1).map((values, index) => {
    const line = index + 2;
    if (values.length !== headers.length) throw error(`Linha ${line}: mantenha as sete colunas da planilha`);
    const [code, id, parentCode, rawTitle, rawOrder, rawArchived] = values.map((value) => value.trim());
    if (!code || byCode.has(code)) throw error(`Linha ${line}: código vazio ou repetido`);
    if (id && (!byId.has(id) || seenIds.has(id))) throw error(`Linha ${line}: ID desconhecido ou repetido. Não altere IDs existentes.`);
    const title = rawTitle.trim();
    if (!title || title.length > 255) throw error(`Linha ${line}: título obrigatório, até 255 caracteres`);
    if (!/^\d+$/.test(rawOrder) || Number(rawOrder) > 1000000) throw error(`Linha ${line}: ordem deve ser um número inteiro não negativo`);
    if (!['0', '1'].includes(rawArchived)) throw error(`Linha ${line}: arquivado deve ser 0 ou 1`);
    if (id) seenIds.add(id);
    const entry = { code, id, parentCode, title, sortOrder: Number(rawOrder), archived: Number(rawArchived) };
    byCode.set(code, entry);
    return entry;
  });
  if (seenIds.size !== existing.length) throw error('A planilha deve manter todas as categorias existentes. Para retirar uma, marque arquivado como 1.');
  for (const entry of parsed) {
    if (entry.parentCode && !byCode.has(entry.parentCode)) throw error(`Categoria ${entry.code}: código_pai não encontrado`);
    if (entry.parentCode && byCode.get(entry.parentCode).archived && !entry.archived) {
      const old = byId.get(entry.id);
      const oldParent = old?.parent_id ? byId.get(old.parent_id) : null;
      if (!oldParent?.archived || byCode.get(entry.parentCode).id !== old.parent_id) throw error(`Categoria ${entry.code}: o tópico superior está arquivado`);
    }
    const visited = new Set([entry.code]); let parent = entry.parentCode;
    while (parent) {
      if (visited.has(parent)) throw error(`Categoria ${entry.code}: há um ciclo na estrutura`);
      visited.add(parent); parent = byCode.get(parent)?.parentCode;
    }
  }
  const changes = parsed.flatMap((entry) => {
    const old = byId.get(entry.id);
    const oldParentCode = old ? parsed.find((candidate) => candidate.id === old.parent_id)?.code || '' : '';
    if (!old) return [{ code: entry.code, title: entry.title, kind: 'criar' }];
    const kinds = [];
    if (old.title !== entry.title) kinds.push('renomear');
    if (oldParentCode !== entry.parentCode) kinds.push('mover');
    if (Number(old.sort_order) !== entry.sortOrder) kinds.push('reordenar');
    if (Number(old.archived) !== entry.archived) kinds.push(entry.archived ? 'arquivar' : 'reativar');
    return kinds.length ? [{ code: entry.code, title: entry.title, kind: kinds.join(', ') }] : [];
  });
  return { rows: parsed, changes, revision: structureRevision(existing) };
}
