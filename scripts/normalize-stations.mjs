#!/usr/bin/env node
// Auditoria/manual da migração de nomenclatura das subestações.
//
//   node scripts/normalize-stations.mjs                       # dry-run (padrão)
//   node scripts/normalize-stations.mjs --apply               # aplica em transação
//   node scripts/normalize-stations.mjs --project <uuid>      # um projeto só
//
// A aplicação também executa esta migração sozinha no start, uma vez por projeto,
// registrada em app_migrations com a chave 'station_titles_v1'. Este script serve
// para conferir o plano antes e para reaplicar manualmente se necessário.
import { writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { planStationChanges, applyStationChanges } from '../server/station-migration.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const projectIndex = args.indexOf('--project');
const PROJECT = projectIndex >= 0 ? args[projectIndex + 1] : '';
const backupIndex = args.indexOf('--backup');
const BACKUP = backupIndex >= 0 ? args[backupIndex + 1] : `normalize-stations-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

if (!process.env.DATABASE_URL) {
  console.error('Defina DATABASE_URL (a mesma configurada no Render) antes de executar.');
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 4000),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)) || 'organizador',
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  timezone: 'Z',
});

const [projects] = PROJECT
  ? await connection.execute('SELECT id,name FROM projects WHERE id=?', [PROJECT])
  : await connection.execute('SELECT id,name FROM projects ORDER BY created_at');
if (!projects.length) {
  console.error(PROJECT ? `Projeto ${PROJECT} não encontrado.` : 'Nenhum projeto encontrado.');
  await connection.end();
  process.exit(1);
}

const backup = { generated_at: new Date().toISOString(), applied: APPLY, projects: [] };
let totalRenames = 0;
let totalCreates = 0;
let blocked = false;

for (const project of projects) {
  const [nodes] = await connection.execute(
    'SELECT id,parent_id,title,archived,sort_order FROM structure_nodes WHERE project_id=? ORDER BY sort_order,title', [project.id]);
  const plan = planStationChanges(nodes);
  backup.projects.push({ id: project.id, name: project.name, renames: plan.renames.map(({ id, from, to }) => ({ id, from, to })), creates: plan.creates });

  console.log(`\n=== ${project.name} (${project.id}) ===`);
  console.log(`nós: ${nodes.length} | renomeações: ${plan.renames.length} | criação: ${plan.creates.length}`);
  for (const rename of plan.renames) console.log(`  ~ "${rename.from}" -> "${rename.to}"   (pai: ${rename.parent})`);
  for (const create of plan.creates) console.log(`  + "${create.title}"   (filha de "${create.parent}")`);
  for (const problem of plan.problems) {
    blocked = true;
    console.error('  ! conflito:', problem);
  }
  totalRenames += plan.renames.length;
  totalCreates += plan.creates.length;
}

if (blocked) {
  console.error('\nPlano abortado — nenhuma escrita foi feita.');
  await connection.end();
  process.exit(2);
}

if (!APPLY) {
  console.log('\nDRY-RUN: nada foi escrito. Rode com --apply para aplicar.');
  await connection.end();
  process.exit(0);
}

await writeFile(BACKUP, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
console.log(`\nBackup do estado anterior: ${BACKUP}`);

for (const project of backup.projects) {
  if (!project.renames.length && !project.creates.length) continue;
  await connection.beginTransaction();
  try {
    await applyStationChanges(connection, project.id, project);
    await connection.commit();
    console.log(`Aplicado em ${project.name}: ${project.renames.length} renomeações, ${project.creates.length} criações.`);
  } catch (error) {
    await connection.rollback();
    console.error('Falha ao aplicar; transação revertida. Backup preservado em', BACKUP);
    throw error;
  }
}
await connection.end();
