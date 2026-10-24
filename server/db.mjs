import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

let pool;
let activeDatabase;

function connectionOptions(includeDatabase = true) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
  const url = new URL(process.env.DATABASE_URL);
  const database = activeDatabase || decodeURIComponent(url.pathname.slice(1));
  return {
    host: url.hostname,
    port: Number(url.port || 4000),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(includeDatabase ? { database } : {}),
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    timezone: 'Z',
  };
}

export function db() {
  if (!pool) {
    pool = mysql.createPool({
      ...connectionOptions(),
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true,
    });
  }
  return pool;
}

async function prepareDatabase() {
  const selected = connectionOptions().database.toLowerCase();
  if (!['', 'sys', 'mysql', 'information_schema', 'performance_schema'].includes(selected)) return;
  const connection = await mysql.createConnection(connectionOptions(false));
  try {
    await connection.query('CREATE DATABASE IF NOT EXISTS `organizador`');
    activeDatabase = 'organizador';
  } finally {
    await connection.end();
  }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY, email VARCHAR(320) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL, created_at VARCHAR(30) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL,
    expires_at VARCHAR(30) NOT NULL, INDEX (user_id), INDEX (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(36) PRIMARY KEY, name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL, created_by VARCHAR(36) NOT NULL,
    created_at VARCHAR(30) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_context_entries (
    id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    author_id VARCHAR(36) NOT NULL, title VARCHAR(255) NOT NULL,
    body LONGTEXT NOT NULL, extracted_text LONGTEXT NOT NULL,
    file_name VARCHAR(255), content_type VARCHAR(120), file_data LONGBLOB,
    archived TINYINT NOT NULL DEFAULT 0, created_at VARCHAR(30) NOT NULL,
    INDEX (project_id), INDEX (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    project_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL,
    role VARCHAR(20) NOT NULL, created_at VARCHAR(30) NOT NULL,
    PRIMARY KEY (project_id, user_id), INDEX (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invitations (
    id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    email VARCHAR(320) NOT NULL, role VARCHAR(20) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE, invited_by VARCHAR(36) NOT NULL,
    expires_at VARCHAR(30) NOT NULL, accepted_at VARCHAR(30),
    created_at VARCHAR(30) NOT NULL, INDEX (project_id), INDEX (email)
  )`,
  `CREATE TABLE IF NOT EXISTS structure_nodes (
    id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    parent_id VARCHAR(36), title VARCHAR(255) NOT NULL,
    sort_order INT NOT NULL, archived TINYINT NOT NULL DEFAULT 0,
    created_at VARCHAR(30) NOT NULL, INDEX (project_id), INDEX (parent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    author_id VARCHAR(36) NOT NULL, title VARCHAR(255) NOT NULL,
    kind VARCHAR(20) NOT NULL, body LONGTEXT,
    file_name VARCHAR(255), content_type VARCHAR(120), file_data LONGBLOB,
    analysis_status VARCHAR(30) NOT NULL, analysis_error TEXT,
    created_at VARCHAR(30) NOT NULL, INDEX (project_id), INDEX (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS source_targets (
    source_id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    node_id VARCHAR(36) NOT NULL, INDEX (project_id), INDEX (node_id)
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    node_id VARCHAR(36), title VARCHAR(255) NOT NULL,
    summary TEXT NOT NULL, location VARCHAR(160) NOT NULL DEFAULT '',
    discipline VARCHAR(160) NOT NULL DEFAULT '', supplier VARCHAR(160) NOT NULL DEFAULT '',
    responsible VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL,
    due_date VARCHAR(10) NOT NULL DEFAULT '', attention TINYINT NOT NULL DEFAULT 0,
    confidence DECIMAL(3,2) NOT NULL DEFAULT 0, latest_source_id VARCHAR(36),
    created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
    INDEX (project_id), INDEX (node_id), INDEX (status), INDEX (updated_at)
  )`,
  `CREATE TABLE IF NOT EXISTS item_updates (
    id VARCHAR(36) PRIMARY KEY, item_id VARCHAR(36) NOT NULL,
    source_id VARCHAR(36), author_id VARCHAR(36),
    summary TEXT NOT NULL, evidence TEXT NOT NULL,
    previous_status VARCHAR(30), new_status VARCHAR(30) NOT NULL,
    created_at VARCHAR(30) NOT NULL, INDEX (item_id), INDEX (source_id)
  )`,
  `CREATE TABLE IF NOT EXISTS item_organization (
    item_id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    title_locked TINYINT NOT NULL DEFAULT 0,
    node_locked TINYINT NOT NULL DEFAULT 0,
    updated_at VARCHAR(30) NOT NULL, INDEX (project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS topic_summaries (
    node_id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL,
    revision CHAR(64) NOT NULL, summary TEXT NOT NULL,
    important_change TEXT NOT NULL, analysis_status VARCHAR(30) NOT NULL,
    analysis_error TEXT, generated_at VARCHAR(30),
    INDEX (project_id), INDEX (analysis_status)
  )`,
  `CREATE TABLE IF NOT EXISTS topic_summary_history (
    node_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL,
    revision CHAR(64) NOT NULL, summary TEXT NOT NULL,
    important_change TEXT NOT NULL, generated_at VARCHAR(30) NOT NULL,
    PRIMARY KEY (node_id, revision), INDEX (project_id), INDEX (generated_at)
  )`,
  `CREATE TABLE IF NOT EXISTS app_migrations (
    project_id VARCHAR(36) NOT NULL, migration_key VARCHAR(100) NOT NULL,
    applied_at VARCHAR(30) NOT NULL, PRIMARY KEY (project_id, migration_key)
  )`,
];

async function addCommissioningStations(connection) {
  const template = JSON.parse(await readFile(new URL('../estrutura-inicial.json', import.meta.url), 'utf8'));
  const section = template.secoes.find((node) => node.titulo === 'Startup e Comissionamento');
  const stationNames = section?.filhos.find((node) => node.titulo === 'Startup das Subestações')?.filhos.map((node) => node.titulo) || [];
  const [projects] = await connection.execute('SELECT id FROM projects');
  for (const project of projects) {
    const [rows] = await connection.execute('SELECT id,parent_id,title FROM structure_nodes WHERE project_id=? AND archived=0', [project.id]);
    const parents = rows.filter((node) => node.title === 'Startup e Comissionamento');
    const target = rows.find((node) => node.title === 'Startup das Subestações' && parents.some((parent) => parent.id === node.parent_id));
    if (!target) continue;
    await connection.beginTransaction();
    try {
      const [marker] = await connection.execute('INSERT IGNORE INTO app_migrations (project_id,migration_key,applied_at) VALUES (?,?,?)', [project.id, 'commissioning_stations_v1', new Date().toISOString()]);
      if (marker.affectedRows) {
        const existing = new Set(rows.filter((node) => node.parent_id === target.id).map((node) => node.title.toLocaleLowerCase('pt-BR')));
        let order = rows.filter((node) => node.parent_id === target.id).length;
        for (const title of stationNames) if (!existing.has(title.toLocaleLowerCase('pt-BR'))) {
          await connection.execute('INSERT INTO structure_nodes (id,project_id,parent_id,title,sort_order,archived,created_at) VALUES (?,?,?,?,?,?,?)',
            [randomUUID(), project.id, target.id, title, order++, 0, new Date().toISOString()]);
        }
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
  }
}

export async function initializeDatabase() {
  await prepareDatabase();
  const connection = await db().getConnection();
  try {
    for (const statement of schema) await connection.query(statement);
    await addCommissioningStations(connection);
    const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
    const password = process.env.BOOTSTRAP_PASSWORD;
    if (!email || !password || password.length < 12) {
      throw new Error('Configure BOOTSTRAP_EMAIL e BOOTSTRAP_PASSWORD com ao menos 12 caracteres');
    }
    const [users] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (!users.length) {
      await connection.execute('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)',
        [randomUUID(), email, await bcrypt.hash(password, 12), new Date().toISOString()]);
    }
  } finally {
    connection.release();
  }
}

export async function createProject(name, description, ownerId, withTemplate) {
  const connection = await db().getConnection();
  const projectId = randomUUID();
  const now = new Date().toISOString();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO projects (id,name,description,created_by,created_at) VALUES (?,?,?,?,?)',
      [projectId, name, description, ownerId, now]);
    await connection.execute('INSERT INTO memberships (project_id,user_id,role,created_at) VALUES (?,?,?,?)',
      [projectId, ownerId, 'owner', now]);
    if (withTemplate) {
      const template = JSON.parse(await readFile(new URL('../estrutura-inicial.json', import.meta.url), 'utf8'));
      async function insertNodes(nodes, parentId = null) {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index];
          const id = randomUUID();
          await connection.execute('INSERT INTO structure_nodes (id,project_id,parent_id,title,sort_order,archived,created_at) VALUES (?,?,?,?,?,?,?)',
            [id, projectId, parentId, node.titulo, index, 0, now]);
          await insertNodes(node.filhos || [], id);
        }
      }
      await insertNodes(template.secoes);
    }
    await connection.commit();
    return projectId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
