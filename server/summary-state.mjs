// Recupera a memória estruturada das sínteses criadas antes de state_json.
// Se uma linha não puder ser atribuída com segurança, a próxima geração usa
// o fluxo completo uma única vez em vez de descartar um fato do relatório.
export function parseLegacySummary(summary, items, isMainSection, generatedAt = '') {
  if (!summary?.trim() || !items.length) return null;
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
  const byId = new Map();
  let station = '';
  let current = null;
  const choose = (line) => {
    const matches = items.filter((item) => line.startsWith(`${item.title}: `));
    if (matches.length === 1) return matches[0];
    if (!matches.length || !station) return null;
    const local = normalize(station);
    const narrowed = matches.filter((item) => normalize(`${item.location || ''} ${item.node_path || ''}`).includes(local));
    return narrowed.length === 1 ? narrowed[0] : null;
  };
  const detail = (line) => line.replace(/ \((?:Situação:|Última informação:)[^\n]*\)$/, '').trim();
  for (const raw of summary.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (isMainSection && line.startsWith('• ')) {
      const heading = line.match(/^• Subestação (.*?) —/);
      if (heading) station = heading[1].trim();
      else if (line.startsWith('• Informações gerais')) station = '';
      else return null;
      current = null;
      continue;
    }
    if (isMainSection) {
      if (!line.startsWith('◦ ')) return null;
      const body = line.slice(2);
      const item = choose(body);
      if (!item) return null;
      const value = detail(body.slice(item.title.length + 2));
      const bullet = byId.get(item.id) || { item_id: item.id, text: '', locations: [] };
      if (station) bullet.locations.push({ name: station, text: value });
      else bullet.text = bullet.text ? `${bullet.text} ${value}` : value;
      byId.set(item.id, bullet);
    } else if (line.startsWith('• ')) {
      const body = line.slice(2);
      const item = choose(body);
      if (!item) return null;
      current = item.id;
      byId.set(item.id, { item_id: item.id, text: detail(body.slice(item.title.length + 2)), locations: [] });
    } else if (line.startsWith('◦ ') && current) {
      const colon = line.indexOf(': ');
      if (colon < 3) return null;
      byId.get(current).locations.push({ name: line.slice(2, colon), text: line.slice(colon + 2) });
    } else return null;
  }
  for (const item of items) {
    if (item.created_at && generatedAt && item.created_at > generatedAt) continue;
    if (!byId.has(item.id)) return null;
  }
  for (const bullet of byId.values()) if (!bullet.text && bullet.locations.length) bullet.text = 'Acompanhamento por local.';
  return [...byId.values()];
}

export function changedSummaryItems(items, updates, priorState, cutoff) {
  const known = new Set((priorState || []).map((bullet) => bullet.item_id));
  const changed = new Set(updates.filter((update) => update.created_at > cutoff).map((update) => update.item_id));
  for (const item of items) if (!known.has(item.id) || item.updated_at > cutoff) changed.add(item.id);
  return changed;
}
