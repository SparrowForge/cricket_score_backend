/* Removes E2E test organizations (cascades to teams/players/tournaments/matches/balls). */
const fs = require('fs');
const path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Order matters: innings/stats reference teams without cascade
  await c.query(`DELETE FROM matches WHERE organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'e2e-club-%')`);
  await c.query(`DELETE FROM tournaments WHERE organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'e2e-club-%')`);
  await c.query(`DELETE FROM teams WHERE organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'e2e-club-%')`);
  const r = await c.query(`DELETE FROM organizations WHERE slug LIKE 'e2e-club-%' RETURNING slug`);
  console.log('deleted e2e orgs:', r.rows.map((x) => x.slug).join(', ') || '(none)');
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
