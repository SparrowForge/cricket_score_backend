const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { StatsService } = require('./dist/matches/stats.service');

const envPath = path.join(__dirname, '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stats = new StatsService(pool, { sendMatchResult: async () => {} });

(async () => {
  try {
    const t20Res = await pool.query("SELECT id FROM match_formats WHERE slug='t20' LIMIT 1");
    const t20 = t20Res.rows[0];
    if (!t20) {
      throw new Error('T20 format not found in match_formats');
    }
    console.log('T20 format id:', t20.id);

    const updateRes = await pool.query('UPDATE tournaments SET format_id = $1 WHERE format_id <> $1 RETURNING id, name, slug', [t20.id]);
    console.log(`Updated ${updateRes.rowCount} tournaments to T20 format.`);
    if (updateRes.rows.length > 0) {
      console.log('Sample updated tournament:', updateRes.rows[0]);
    }

    const matchesRes = await pool.query("SELECT id, tournament_id, status FROM matches WHERE status = 'completed' ORDER BY completed_at NULLS LAST");
    const matchIds = matchesRes.rows.map((row) => row.id);
    console.log(`Found ${matchIds.length} completed matches to finalize.`);

    for (const matchId of matchIds) {
      console.log(`Finalizing stats for match ${matchId}...`);
      await stats.finalizeMatch(matchId);
    }

    console.log('Recalculation complete.');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
