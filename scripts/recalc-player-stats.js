/* Recalculate all player tournament stats from match scoreboard. */
const fs = require('fs');
const path = require('path');
const BE = path.resolve(__dirname, '..');
for (const l of fs.readFileSync(path.join(BE, '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { Client } = require('pg');

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  try {
    await pg.query('BEGIN');

    // Clear existing stats
    console.log('Clearing existing player tournament stats…');
    await pg.query('DELETE FROM player_tournament_stats');

    // Recalculate from match data
    console.log('Recalculating from match scoreboard…');
    const res = await pg.query(`
      INSERT INTO player_tournament_stats (
        player_id, tournament_id, team_id,
        matches_played, innings_batted, not_outs, runs_scored, balls_faced,
        highest_score, highest_score_not_out,
        innings_bowled, balls_bowled, runs_conceded, wickets_taken, maidens
      )
      SELECT
        p.id AS player_id,
        m.tournament_id,
        pms.team_id,
        COUNT(DISTINCT m.id)::smallint AS matches_played,
        COALESCE(SUM(CASE WHEN pms.batted THEN 1 ELSE 0 END), 0)::smallint AS innings_batted,
        COALESCE(SUM(CASE WHEN pms.batted AND NOT pms.is_out THEN 1 ELSE 0 END), 0)::smallint AS not_outs,
        COALESCE(SUM(pms.runs_scored), 0)::integer AS runs_scored,
        COALESCE(SUM(pms.balls_faced), 0)::integer AS balls_faced,
        COALESCE(MAX(CASE WHEN pms.batted THEN pms.runs_scored ELSE NULL END), 0)::smallint AS highest_score,
        COALESCE(MAX(CASE WHEN pms.batted AND NOT pms.is_out THEN pms.runs_scored ELSE NULL END), 0)::boolean AS highest_score_not_out,
        COALESCE(SUM(CASE WHEN pms.balls_bowled > 0 THEN 1 ELSE 0 END), 0)::smallint AS innings_bowled,
        COALESCE(SUM(pms.balls_bowled), 0)::integer AS balls_bowled,
        COALESCE(SUM(pms.runs_conceded), 0)::integer AS runs_conceded,
        COALESCE(SUM(pms.wickets_taken), 0)::smallint AS wickets_taken,
        COALESCE(SUM(CASE WHEN pms.balls_bowled > 0 AND pms.runs_conceded = 0 THEN 1 ELSE 0 END), 0)::smallint AS maidens
      FROM player_match_stats pms
      JOIN players p ON p.id = pms.player_id
      JOIN matches m ON m.id = pms.match_id
      WHERE m.status = 'completed' AND p.deleted_at IS NULL
      GROUP BY p.id, m.tournament_id, pms.team_id
      HAVING COUNT(*) > 0
      ON CONFLICT (tournament_id, player_id) DO UPDATE SET
        matches_played = EXCLUDED.matches_played,
        innings_batted = EXCLUDED.innings_batted,
        not_outs = EXCLUDED.not_outs,
        runs_scored = EXCLUDED.runs_scored,
        balls_faced = EXCLUDED.balls_faced,
        highest_score = EXCLUDED.highest_score,
        highest_score_not_out = EXCLUDED.highest_score_not_out,
        innings_bowled = EXCLUDED.innings_bowled,
        balls_bowled = EXCLUDED.balls_bowled,
        runs_conceded = EXCLUDED.runs_conceded,
        wickets_taken = EXCLUDED.wickets_taken,
        maidens = EXCLUDED.maidens
    `);
    console.log('Updated', res.rowCount, 'tournament stat rows');

    await pg.query('COMMIT');
    console.log('✓ Player tournament stats recalculated');
  } catch (e) {
    await pg.query('ROLLBACK');
    console.error('✗ Recalculation failed:', e.message);
    process.exit(1);
  } finally {
    await pg.end();
  }
})();
