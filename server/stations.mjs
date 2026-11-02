// Registro canônico de subestações.
//
// O `location` dos assuntos é texto livre escrito pela IA e pelas pessoas, então a
// mesma subestação chega como "Ourolândia", "Ourolândia II", "SE Ourolândia II,
// lote GS3", "Ceará-Mirim (Axia)" ou "João Pessoa do TAF". Agrupar por string crua
// criava uma seção por variante. Este módulo resolve cada menção ao nome canônico.
//
// Os nomes canônicos seguem a denominação do edital (Anexos 2-04, 2-06 e 2-14) e do
// documento de contexto do projeto: 15 subestações distintas nos lotes GS1, GS2 e GS3.
// Ajuste esta tabela quando a nomenclatura oficial mudar.

// Cada grupo: nome canônico + variações que apontam para ele.
export const STATION_GROUPS = [
  { canonical: 'Ceará Mirim II', aliases: ['Ceará-Mirim', 'Ceará Mirim', 'Ceará-Mirim II', 'Ceará Mirim II', 'Ceará-Mirim (Axia)', 'Ceará Mirim (Axia)'] },
  { canonical: 'João Pessoa II', aliases: ['João Pessoa', 'João Pessoa TAF', 'João Pessoa do TAF'] },
  { canonical: 'Pau Ferro', aliases: [] },
  { canonical: 'Garanhuns II', aliases: ['Garanhuns'] },
  { canonical: 'Messias', aliases: [] },
  { canonical: 'Pilões III', aliases: ['Pilões'] },
  { canonical: 'Jussiape', aliases: [] },
  { canonical: 'São João do Paraíso', aliases: ['São João Paraíso', 'SJP'] },
  { canonical: 'Capelinha 3', aliases: ['Capelinha'] },
  { canonical: 'Itabira 5', aliases: ['Itabira'] },
  { canonical: 'Igaporã III', aliases: ['Igaporã'] },
  { canonical: 'Ibicoara', aliases: [] },
  { canonical: 'Ourolândia II', aliases: ['Ourolândia', 'Ourilândia'] },
  { canonical: 'Extremoz II', aliases: ['Extremoz'] },
  { canonical: 'Campina Grande III', aliases: ['Campina Grande'] },
];

// Palavras que aparecem junto do nome e não fazem parte dele.
const NOISE_TOKENS = new Set(['se', 'subestacao', 'subestacoes', 'sub', 'do', 'da', 'de', 'dos', 'das',
  'lote', 'lotes', 'registro', 'registrada', 'registrado', 'citada', 'citado', 'como', 'taf', 'gst',
  'taesa', 'axia', 'argo', 'argoi', 'chesf', 'kv', 'e']);
const ROMAN = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi']);

// Escopos que distinguem DUAS frentes na mesma subestação. Decisão do projeto: em
// Jussiape convivem a implantação do Grande Sertão e as instalações da TAESA, e as
// duas devem permanecer separadas. Para as demais estações a empresa é só ruído.
export const STATION_SCOPES = {
  jussiape: {
    GST: { canonical: 'Jussiape (GST)', aliases: ['Jussiape GST', 'Jussiape — GST', 'Jussiape - GST'] },
    TAESA: { canonical: 'Jussiape (TAESA)', aliases: ['Jussiape TAESA', 'Jussiape — TAESA', 'Jussiape - TAESA'] },
  },
};

const SCOPE_TOKENS = { gst: 'GST', taesa: 'TAESA', axia: 'AXIA', chesf: 'AXIA', argo: 'ARGO', argoi: 'ARGO', ieg: 'IEG', isa: 'ISA', sterlite: 'STERLITE', mantiqueira: 'MANTIQUEIRA' };

function detectScope(value) {
  const tokens = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z]+/g) || [];
  for (const token of tokens) if (SCOPE_TOKENS[token]) return SCOPE_TOKENS[token];
  return '';
}

export function normalizeStation(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(Argo)", "(Axia)", "(citada como Itabira)"
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Remove ruído das pontas e do meio, preservando numerais romanos e números finais,
// que distinguem estações de verdade (Pilões II x Pilões III).
function isNoiseToken(token) {
  return NOISE_TOKENS.has(token) || /^gs\d*$/.test(token) || /^lote\d+$/.test(token);
}

function cleanTokens(value) {
  const tokens = normalizeStation(value).split(' ').filter(Boolean);
  while (tokens.length && isNoiseToken(tokens[0])) tokens.shift();
  const kept = tokens.filter((token, index) => index === 0 || !isNoiseToken(token));
  while (kept.length > 1 && isNoiseToken(kept[kept.length - 1])) kept.pop();
  return kept;
}

function distance(a, b) {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return previous[b.length];
}

// Títulos de nós que representam subestações: filhos de "Startup das Subestações"
// ou de qualquer ramo "por subestação".
function stationBranchTitles(nodes = []) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const titles = [];
  for (const node of nodes) {
    const parent = byId.get(node.parent_id);
    const parentTitle = parent?.title || '';
    if (/startup das subesta|por subesta/i.test(parentTitle)) titles.push(node.title);
    else if (/^startup das subesta/i.test(node.title)) titles.push(...nodes.filter((child) => child.parent_id === node.id).map((child) => child.title));
  }
  return titles;
}

// Lista de subestações do projeto: os 15 grupos conhecidos + eventuais estações que
// existam apenas na estrutura (sem grupo). Título da estrutura vira apelido do grupo.
export function buildStationRegistry(nodes = []) {
  const entries = [];
  const byKey = new Map(); // chave normalizada -> entry
  const addKey = (entry, value) => {
    const key = normalizeStation(value);
    if (!key) return;
    entry.keys.add(key);
    if (!entry.labels.includes(String(value).trim())) entry.labels.push(String(value).trim());
    if (!byKey.has(key)) byKey.set(key, entry);
  };
  const add = (canonical, aliases = []) => {
    const key = normalizeStation(canonical);
    if (!key) return null;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { canonical: String(canonical).trim(), keys: new Set(), labels: [] };
      entries.push(entry);
      byKey.set(key, entry);
    }
    addKey(entry, canonical);
    for (const alias of aliases) addKey(entry, alias);
    return entry;
  };

  for (const group of STATION_GROUPS) add(group.canonical, group.aliases);

  // Frentes com escopo próprio (Jussiape GST / TAESA): entram como identidades
  // separadas, com chave pelo nome qualificado para não colidir com a estação base.
  for (const [base, scopes] of Object.entries(STATION_SCOPES)) {
    if (!byKey.has(base)) continue;
    for (const scope of Object.values(scopes)) {
      const key = normalizeStation(scope.canonical);
      const entry = { canonical: scope.canonical, keys: new Set(), labels: [scope.canonical] };
      for (const label of [scope.canonical, ...scope.aliases]) {
        const labelKey = normalizeStation(label);
        if (!labelKey || labelKey === base) continue;
        entry.keys.add(labelKey);
        if (!entry.labels.includes(label)) entry.labels.push(label);
        if (!byKey.has(labelKey)) byKey.set(labelKey, entry);
      }
      if (key && key !== base) entry.keys.add(key);
      entries.push(entry);
    }
  }

  for (const title of stationBranchTitles(nodes)) {
    const cleaned = cleanTokens(title).join(' ');
    const entry = byKey.get(cleaned) || byKey.get(normalizeStation(title));
    // Estação da estrutura sem grupo conhecido entra como nome próprio, aceitando
    // também a menção sem ruído ("SE Nova Fronteira" -> "nova fronteira").
    if (entry) addKey(entry, title);
    else {
      const created = add(title);
      if (created && cleaned) {
        created.keys.add(cleaned);
        if (!byKey.has(cleaned)) byKey.set(cleaned, created);
      }
    }
  }

  for (const entry of entries) addKey(entry, entry.canonical);
  return entries;
}

// Lista compacta para o prompt: nome canônico e as variações que devem apontar para ele.
export function stationListForPrompt(registry = [], { maxAliases = 5 } = {}) {
  return registry.map((entry) => {
    const canonicalKey = normalizeStation(entry.canonical);
    const aliases = entry.labels.filter((label) => normalizeStation(label) !== canonicalKey).slice(0, maxAliases);
    return aliases.length ? `- ${entry.canonical} (também citada como: ${aliases.join('; ')})` : `- ${entry.canonical}`;
  }).join('\n');
}

// Resolve uma menção livre para o nome canônico. Devolve '' quando não há
// correspondência segura — quem chama decide o que fazer (nunca inventar).
function resolveStationBase(value, registry = []) {
  if (!registry.length) return '';
  const raw = normalizeStation(value);
  if (!raw) return '';

  // 1. Correspondência exata (inclui apelidos conhecidos).
  for (const entry of registry) if (entry.keys.has(raw)) return entry.canonical;

  // 2. Nome sem ruído: "João Pessoa do TAF" -> "joao pessoa"; "SE Ourolândia II, lote GS3" -> "ourolandia ii".
  const cleaned = cleanTokens(value).join(' ');
  if (cleaned) {
    for (const entry of registry) if (entry.keys.has(cleaned)) return entry.canonical;
    // 2b. O nome canônico é prefixo da menção, com sobra numérica/romana conciliável.
    const partial = registry
      .filter((entry) => [...entry.keys].some((key) => cleaned === key || cleaned.startsWith(`${key} `)))
      .sort((a, b) => b.canonical.length - a.canonical.length);
    if (partial.length === 1) {
      const entry = partial[0];
      const key = [...entry.keys].find((candidate) => cleaned === candidate || cleaned.startsWith(`${candidate} `)) || '';
      const rest = cleaned.slice(key.length).trim().split(' ').filter(Boolean);
      const harmless = rest.every((token) => /^\d{2,4}$/.test(token)); // "500", "230"
      const roman = rest.every((token) => ROMAN.has(token));
      if (harmless && !roman) return entry.canonical;
    }
  }

  // 3. Erro de digitação: distância pequena e um único candidato plausível.
  const scored = registry
    .map((entry) => ({ entry, best: Math.min(...[...entry.keys].map((key) => distance(raw, key))) }))
    .sort((a, b) => a.best - b.best);
  const [first, second] = scored;
  if (first && first.best <= 2 && (!second || second.best > first.best) && raw.length >= 6) return first.entry.canonical;
  // 3b. Mesmo erro aplicado ao nome sem ruído ("Ourolandia II").
  if (cleaned && cleaned !== raw) {
    const cleanedScored = registry
      .map((entry) => ({ entry, best: Math.min(...[...entry.keys].map((key) => distance(cleaned, key))) }))
      .sort((a, b) => a.best - b.best);
    const [cFirst, cSecond] = cleanedScored;
    if (cFirst && cFirst.best <= 2 && (!cSecond || cSecond.best > cFirst.best) && cleaned.length >= 6) return cFirst.entry.canonical;
  }

  return '';
}

// Menção que cita várias subestações ("Jussiape, Ibicoara e Igaporã"): devolve todas
// as canônicas reconhecidas. Vazio quando não há nenhuma correspondência segura.
export function canonicalStation(value, registry = []) {
  const base = resolveStationBase(value, registry);
  if (!base) return '';
  // Escopo: "Jussiape (TAESA)" e "Jussiape (GST)" são frentes distintas da mesma SE.
  const scope = detectScope(value);
  if (scope) {
    const scoped = STATION_SCOPES[normalizeStation(base)]?.[scope];
    if (scoped) return scoped.canonical;
  }
  return base;
}

export function canonicalStations(value, registry = []) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const single = canonicalStation(text, registry);
  if (single) return [single];
  const parts = text.split(/\s*[,;/]\s*|\s+e\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const found = [];
  for (const part of parts) {
    const canonical = canonicalStation(part, registry);
    if (canonical && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

// Nome para exibição e chave de agrupamento: canônico quando resolvido.
export function resolveStationName(value, registry = []) {
  const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return canonicalStation(trimmed, registry) || trimmed;
}

export function stationKey(value, registry = []) {
  const canonical = resolveStationName(value, registry);
  const scope = detectScope(canonical);
  const base = normalizeStation(canonical);
  // O escopo entra na chave: "Jussiape (GST)" e "Jussiape (TAESA)" não se agrupam.
  return scope && STATION_SCOPES[base]?.[scope] ? `${base} ${scope.toLowerCase()}` : base;
}
