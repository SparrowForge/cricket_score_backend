#!/usr/bin/env node

/**
 * Backfill for the "last batter in never appears" bug.
 *
 * A batter who reached the crease but never faced a delivery — the one left
 * 0* at the non-striker's end when the innings ended — was derived out of
 * existence: `buildPlayerMatchStats` keyed the batting side off striker rows
 * only, so that player got no `player_match_stats` row at all, and with it no
 * innings batted, no not-out, and no place in the MVP, tournament or career
 * rollups.
 *
 * The scorecard endpoint recomputes from `balls` on every request, so it is
 * already correct once the code ships. Only the materialised per-match facts
 * need repairing, which this does by replaying the (now fixed) derivation.
 *
 * Run AFTER `npm run build`, from the backend directory:
 *   node scripts/backfill-crease-batters.js --dry-run
 *   node scripts/backfill-crease-batters.js
 */

const fs = require('fs');
const path = require('path');

// Minimal .env loader, same as scripts/migrate.js (no dotenv dependency needed)
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const { Pool } = require('pg');
const distStats = path.join(__dirname, '..', 'dist', 'matches', 'stats.service.js');
if (!fs.existsSync(distStats)) {
  console.error('dist/matches/stats.service.js missing — run `npm run build` first.');
  process.exit(1);
}
const { StatsService } = require(distStats);

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Completed matches where somebody stood at the non-striker's end but is
 * missing from player_match_stats, or is recorded there as not having batted.
 */
const AFFECTED_SQL = `
  WITH crease AS (
    SELECT DISTINCT i.match_id, b.non_striker_id AS player_id
    FROM balls b JOIN innings i ON i.id = b.innings_id
    WHERE NOT b.is_superseded
  )
  SELECT c.match_id, count(*)::int AS ghost_batters,
         string_agg(p.full_name, ', ' ORDER BY p.full_name) AS names
  FROM crease c
  JOIN matches m ON m.id = c.match_id
  JOIN players p ON p.id = c.player_id
  LEFT JOIN player_match_stats pms
         ON pms.match_id = c.match_id AND pms.player_id = c.player_id
  WHERE m.status = 'completed' AND (pms.player_id IS NULL OR NOT pms.batted)
  GROUP BY c.match_id
  ORDER BY c.match_id`;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
  // recalculateMatchStats never notifies, so the push dependency is inert here.
  const stats = new StatsService(pool, { sendMatchResult: async () => {} });

  try {
    const affected = (await pool.query(AFFECTED_SQL)).rows;
    if (affected.length === 0) {
      console.log('Nothing to backfill — every batter who reached the crease already has a row.');
      return;
    }

    console.log(`${affected.length} completed match(es) with a batter missing from player_match_stats:`);
    for (const r of affected) console.log(`  ${r.match_id}  ${r.ghost_batters} × ${r.names}`);

    if (DRY_RUN) { console.log('\n--dry-run: nothing written.'); return; }

    console.log('');
    let ok = 0;
    const failed = [];
    for (const r of affected) {
      try {
        await stats.recalculateMatchStats(r.match_id);
        ok++;
        console.log(`  recalculated ${r.match_id}`);
      } catch (err) {
        failed.push(r.match_id);
        console.error(`  FAILED ${r.match_id}: ${err.message}`);
      }
    }

    const left = (await pool.query(AFFECTED_SQL)).rows;
    console.log(`\nRecalculated ${ok}/${affected.length}; ${left.length} match(es) still affected.`);
    if (failed.length || left.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
