/**
 * Backfill thirties/twenties/two_wkt_hauls/four_wkt_hauls on player_tournament_stats.
 *
 * Migration 20_add_milestone_counters.sql added these columns after many
 * tournaments had already been finalized, so existing rows default to 0 even
 * though the source data (player_match_stats) has always had enough detail to
 * compute them. This replays the same rebuild query stats.service.ts's
 * rebuildTournamentStats() uses, scoped to every tournament that has
 * player_match_stats rows, so it converges every column to the true totals —
 * not just the four new ones.
 *
 * Usage:
 *   node scripts/backfill-milestone-counters.js           # dry run (prints, no writes)
 *   node scripts/backfill-milestone-counters.js --apply   # write to the DB
 */
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function rebuildOne(client, tournamentId) {
  const before = (
    await client.query(
      `SELECT coalesce(sum(thirties),0)::int AS thirties, coalesce(sum(twenties),0)::int AS twenties,
              coalesce(sum(two_wkt_hauls),0)::int AS two_wkt_hauls, coalesce(sum(four_wkt_hauls),0)::int AS four_wkt_hauls,
              count(*)::int AS rows
       FROM player_tournament_stats WHERE tournament_id = $1`,
      [tournamentId],
    )
  ).rows[0];

  await client.query(`DELETE FROM player_tournament_stats WHERE tournament_id = $1`, [tournamentId]);
  await client.query(
    `INSERT INTO player_tournament_stats (tournament_id, player_id, team_id, matches_played,
       innings_batted, runs_scored, balls_faced, not_outs, highest_score, highest_score_not_out,
       fifties, hundreds, thirties, twenties, fours, sixes, ducks,
       innings_bowled, balls_bowled, runs_conceded, wickets_taken, best_bowling,
       two_wkt_hauls, three_wkt_hauls, four_wkt_hauls, five_wkt_hauls, maidens, catches, stumpings, run_outs, mvp_points)
     SELECT tournament_id, player_id, max(team_id::text)::uuid,
            count(*)::int,
            count(*) FILTER (WHERE batted)::int,
            sum(runs_scored)::int, sum(balls_faced)::int,
            count(*) FILTER (WHERE batted AND NOT is_out)::int,
            coalesce(max(runs_scored),0)::int,
            bool_or(runs_scored = (SELECT max(p2.runs_scored) FROM player_match_stats p2
                     WHERE p2.tournament_id = pms.tournament_id AND p2.player_id = pms.player_id) AND NOT is_out),
            count(*) FILTER (WHERE runs_scored >= 50 AND runs_scored < 100)::int,
            count(*) FILTER (WHERE runs_scored >= 100)::int,
            count(*) FILTER (WHERE runs_scored >= 30 AND runs_scored < 50)::int,
            count(*) FILTER (WHERE runs_scored >= 20 AND runs_scored < 30)::int,
            sum(fours)::int, sum(sixes)::int,
            count(*) FILTER (WHERE batted AND is_out AND runs_scored = 0)::int,
            count(*) FILTER (WHERE bowled)::int,
            sum(balls_bowled)::int, sum(runs_conceded)::int, sum(wickets_taken)::int,
            (SELECT jsonb_build_object('wickets', p3.wickets_taken, 'runs', p3.runs_conceded)
             FROM player_match_stats p3
             WHERE p3.tournament_id = pms.tournament_id AND p3.player_id = pms.player_id AND p3.bowled
             ORDER BY p3.wickets_taken DESC, p3.runs_conceded ASC LIMIT 1),
            count(*) FILTER (WHERE wickets_taken >= 2 AND wickets_taken < 3)::int,
            count(*) FILTER (WHERE wickets_taken >= 3 AND wickets_taken < 5)::int,
            count(*) FILTER (WHERE wickets_taken >= 4 AND wickets_taken < 5)::int,
            count(*) FILTER (WHERE wickets_taken >= 5)::int,
            sum(maidens)::int, sum(catches)::int, sum(stumpings)::int, sum(run_outs)::int,
            sum(mvp_points)
     FROM player_match_stats pms
     WHERE tournament_id = $1
     GROUP BY tournament_id, player_id`,
    [tournamentId],
  );

  const after = (
    await client.query(
      `SELECT coalesce(sum(thirties),0)::int AS thirties, coalesce(sum(twenties),0)::int AS twenties,
              coalesce(sum(two_wkt_hauls),0)::int AS two_wkt_hauls, coalesce(sum(four_wkt_hauls),0)::int AS four_wkt_hauls,
              count(*)::int AS rows
       FROM player_tournament_stats WHERE tournament_id = $1`,
      [tournamentId],
    )
  ).rows[0];

  return { before, after };
}

async function main() {
  const client = await pool.connect();
  try {
    const tournaments = (
      await client.query(`SELECT DISTINCT tournament_id FROM player_match_stats WHERE tournament_id IS NOT NULL`)
    ).rows;
    console.log(`Found ${tournaments.length} tournament(s) with match stats\n`);

    let changed = 0;
    for (const { tournament_id } of tournaments) {
      await client.query('BEGIN');
      try {
        const { before, after } = await rebuildOne(client, tournament_id);
        const diffed = ['thirties', 'twenties', 'two_wkt_hauls', 'four_wkt_hauls']
          .filter((k) => before[k] !== after[k]);

        if (!APPLY) {
          await client.query('ROLLBACK');
        } else {
          await client.query('COMMIT');
        }

        if (diffed.length || before.rows !== after.rows) {
          changed++;
          console.log(
            `${APPLY ? '✓ applied' : '· would change'} ${tournament_id}  rows ${before.rows}->${after.rows}  ` +
            diffed.map((k) => `${k} ${before[k]}->${after[k]}`).join('  '),
          );
        } else {
          console.log(`= unchanged ${tournament_id}`);
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`✗ error on tournament ${tournament_id}:`, err.message);
      }
    }

    console.log(`\n${APPLY ? 'Applied' : 'DRY RUN — nothing written.'} ${changed}/${tournaments.length} tournament(s) had a milestone-count change.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
