const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    const t20 = (await pool.query("SELECT id,name,slug,is_builtin FROM match_formats WHERE slug='t20' LIMIT 1")).rows[0];
    console.log('T20 format:', JSON.stringify(t20));
    const counts = (await pool.query('SELECT f.slug, count(*) AS tournaments FROM tournaments t JOIN match_formats f ON f.id=t.format_id GROUP BY f.slug ORDER BY tournaments DESC')).rows;
    console.log('tournament counts by format:', JSON.stringify(counts));
    const matches = (await pool.query('SELECT status, count(*) AS matches FROM matches GROUP BY status ORDER BY status')).rows;
    console.log('match counts by status:', JSON.stringify(matches));
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
