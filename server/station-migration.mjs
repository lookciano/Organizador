// Migração de nomenclatura das subestações na estrutura.
//
// Roda uma única vez por projeto no start da aplicação (registrada em app_migrations)
// e também pode ser executada manualmente para auditoria:
//   node scripts/normalize-stations.mjs            (dry-run)
//   node scripts/normalize-stations.mjs --apply
//
// O que faz:
//   1. Renomeia nós de subestação para o nome canônico do edital ("Ceará-Mirim (Axia)"
//      -> "Ceará Mirim II"). Jussiape (GST) e Jussiape (TAESA) seguem separadas.
//   2. Cria "Extremoz II" e "Campina Grande III" como filhas de "Pilões III" no ramo
//      "Projetos Construtivos — por subestação".
//
// Não altera assuntos, não arquiva e não apaga nada. Se houver qualquer risco de
// título duplicado sob o mesmo pai, o plano é abortado e nada é gravado.
import { randomUUID } from 'node:crypto';
import { buildStationRegistry, canonicalStation, normalizeStation, stationKey } from './stations.mjs';

export const STATION_MIGRATION_KEY = 'station_titles_v1';
const NEW_STATIONS = ['Extremoz II', 'Campina Grande III'];
const PARENT_BRANCH = /por subesta[cç][aã]o/i;

export function planStationChanges(nodes = []) {
  const registry = buildStationRegistry(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const titleOf = (id) => byId.get(id)?.title || '';
  const renames = [];
  for (const node of nodes) {
    if (node.archived) continue;
    const canonical = canonicalStation(node.title, registry);
    if (canonical && canonical !== node.title) renames.push({ id: node.id, from: node.title, to: canonical, parent: titleOf(node.parent_id) || '(raiz)' });
  }

  const problems = [];
  const seen = new Map();
  for (const node of nodes) {
    if (node.archived) continue;
    const renamed = renames.find((item) => item.id === node.id);
    const finalTitle = renamed ? renamed.to : node.title;
    const key = `${node.parent_id || 'root'}|${stationKey(finalTitle, registry)}`;
    if (seen.has(key)) problems.push(`"${finalTitle}" ficaria duplicado sob "${titleOf(node.parent_id) || '(raiz)'}"`);
    seen.set(key, node.id);
  }

  const creates = [];
  for (const node of nodes) {
    if (node.archived || !PARENT_BRANCH.test(titleOf(node.parent_id))) continue;
    if (canonicalStation(node.title, registry) !== 'Pilões III') continue;
    const children = nodes.filter((child) => child.parent_id === node.id && !child.archived);
    for (const name of NEW_STATIONS) {
      if (children.some((child) => normalizeStation(child.title) === normalizeStation(name))) continue;
      creates.push({ parent_id: node.id, parent: node.title, title: name, sort_order: (children.at(-1)?.sort_order ?? 0) + 1 });
    }
    break; // cria em um único ramo por projeto
  }

  return { renames, creates, problems };
}

async function loadNodes(connection, projectId) {
  const [nodes] = await connection.execute(
    'SELECT id,parent_id,title,archived,sort_order FROM structure_nodes WHERE project_id=? ORDER BY sort_order,title', [projectId]);
  return nodes;
}

export async function applyStationChanges(connection, projectId, plan) {
  await connection.execute(
    'INSERT IGNORE INTO app_migrations (project_id,migration_key,applied_at) VALUES (?,?,?)',
    [projectId, STATION_MIGRATION_KEY, new Date().toISOString()]);
  for (const rename of plan.renames) {
    await connection.execute('UPDATE structure_nodes SET title=? WHERE id=? AND project_id=?', [rename.to, rename.id, projectId]);
  }
  for (const create of plan.creates) {
    await connection.execute(
      'INSERT INTO structure_nodes (id,project_id,parent_id,title,sort_order,archived,created_at) VALUES (?,?,?,?,?,0,?)',
      [randomUUID(), projectId, create.parent_id, create.title, create.sort_order, new Date().toISOString()]);
  }
}

// Executada no start (db.mjs). Idempotente: cada projeto é migrado uma única vez.
export async function migrateStationTitles(connection) {
  const [projects] = await connection.execute('SELECT id,name FROM projects');
  for (const project of projects) {
    try {
      const [applied] = await connection.execute('SELECT 1 FROM app_migrations WHERE project_id=? AND migration_key=?', [project.id, STATION_MIGRATION_KEY]);
      if (applied.length) continue;
      const nodes = await loadNodes(connection, project.id);
      if (!nodes.length) continue;
      const plan = planStationChanges(nodes);
      if (plan.problems.length) {
        console.warn('Migração de subestações ignorada:', project.name, plan.problems);
        continue;
      }
      if (!plan.renames.length && !plan.creates.length) {
        await connection.execute('INSERT IGNORE INTO app_migrations (project_id,migration_key,applied_at) VALUES (?,?,?)',
          [project.id, STATION_MIGRATION_KEY, new Date().toISOString()]);
        continue;
      }
      await connection.beginTransaction();
      try {
        await applyStationChanges(connection, project.id, plan);
        await connection.commit();
        // Estado anterior fica no log, para conferência e reversão manual se preciso.
        console.info('Migração de subestações aplicada:', project.name,
          { renomeadas: plan.renames.length, criadas: plan.creates.length, anteriores: plan.renames.map((item) => `${item.from} -> ${item.to}`) });
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } catch (error) {
      // Nunca impede o start por causa desta migração.
      console.error('Falha na migração de subestações:', project.name, error?.message || error);
    }
  }
}
