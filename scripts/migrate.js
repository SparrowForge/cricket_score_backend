/* eslint-disable no-console */
/**
 * Migration runner for Neon.
 *  1. Ensures the target database (from DATABASE_URL path) exists —
 *     connects to the instance's default DB (neondb/postgres) and CREATE DATABASE if missing.
 *  2. Applies migrations/*.sql in filename order, once each, tracked in schema_migrations.
 *
 * Usage: node scripts/migrate.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Minimal .env loader (no dotenv dependency needed)
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

const RAW_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!RAW_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const url = new URL(RAW_URL);
const targetDb = url.pathname.replace(/^\//, '') || 'cricket_score';
// Neon: strip "-pooler" for a direct connection (CREATE DATABASE cannot run via pgbouncer tx mode)
const directHost = url.hostname.replace('-pooler', '');

function clientFor(host, database) {
  return new Client({
    host,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: { rejectUnauthorized: false },
  });
}

async function ensureDatabase() {
  for (const host of [directHost, url.hostname]) {
    for (const adminDb of ['neondb', 'postgres']) {
      const client = clientFor(host, adminDb);
      try {
        await client.connect();
        const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
        if (exists.rowCount === 0) {
          console.log(`Creating database "${targetDb}" (via ${host}/${adminDb})…`);
          await client.query(`CREATE DATABASE "${targetDb.replace(/"/g, '""')}"`);
        }
        console.log(`Database "${targetDb}" is present.`);
        await client.end();
        return;
      } catch (err) {
        await client.end().catch(() => {});
        if (err.code === '3D000') continue; // admin db doesn't exist, try next
        if (err.message.includes('already exists')) { console.log(`Database "${targetDb}" already exists.`); return; }
        console.warn(`(${host}/${adminDb}) ${err.message}`);
      }
    }
  }
  throw new Error(`Could not connect to any admin database to ensure "${targetDb}" exists`);
}

async function applyMigrations() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const client = clientFor(directHost, targetDb);
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const done = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

  for (const file of files) {
    if (done.has(file)) { console.log(`= skip  ${file} (already applied)`); continue; }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`> apply ${file} … `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED\n  ${err.message}`);
      await client.end();
      process.exit(1);
    }
  }

  const tables = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
  console.log(`\nDone. ${tables.rows[0].n} tables/views in "${targetDb}".`);
  await client.end();
}

(async () => {
  await ensureDatabase();
  await applyMigrations();
})().catch((err) => { console.error(err); process.exit(1); });
