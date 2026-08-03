#!/usr/bin/env node

/**
 * Recalculate MVP points for all completed matches after formula change.
 * Run with: node scripts/recalculate-mvp.js
 *
 * Changes:
 * - Updated batting milestones to be format-dependent (1-20 overs vs 21+ overs)
 * - Removed +2 win bonus (winning team now only gets 1.1x multiplier)
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true, max: 4 });

/** --dry-run rolls every match back; nothing is written. */
const DRY_RUN = process.argv.includes('--dry-run');

async function recalculateMvpForMatch(client, matchId) {
  try {
    await client.query('BEGIN');
    const match = (await client.query(`SELECT * FROM matches WHERE id = $1`, [matchId])).rows[0];
    if (!match) return;

    // Delete and rebuild MVP points using the new formula
    await client.query(`DELETE FROM match_mvp_points WHERE match_id = $1`, [matchId]);

    await client.query(
      `WITH mrr AS (
         SELECT CASE WHEN sum(legal_balls) > 0
                     THEN sum(total_runs)::numeric * 6 / sum(legal_balls)
                     ELSE 0 END AS rr
         FROM innings WHERE match_id = $1
       ),
       ov AS (
         SELECT coalesce(
                  (SELECT (m.rules_snapshot->>'overs_per_innings')::numeric
                     FROM matches m WHERE m.id = $1),
                  (SELECT max(max_overs)::numeric FROM innings WHERE match_id = $1),
                  20) AS o
       ),
       big_wickets AS (
         SELECT b.bowler_id AS player_id,
                sum(least(victim.runs * 0.2, 4))::numeric AS victim_value
         FROM balls b
         JOIN innings i ON i.id = b.innings_id
         CROSS JOIN LATERAL (
           SELECT coalesce(sum(b2.runs_batter), 0) AS runs
           FROM balls b2
           WHERE b2.innings_id = b.innings_id AND b2.striker_id = b.dismissed_player_id
             AND b2.seq <= b.seq AND NOT b2.is_superseded
         ) victim
         WHERE i.match_id = $1 AND b.is_wicket AND NOT b.is_superseded
           AND b.wicket_type NOT IN ('run_out','retired_hurt','retired_out','obstructing_field','timed_out')
         GROUP BY b.bowler_id
       ),
       fielding_errors AS (
         SELECT ce.fielder_player_id AS player_id,
                count(*) FILTER (WHERE ce.body LIKE 'DROPPED CATCH!%')::int AS dropped_catches,
                count(*) FILTER (WHERE ce.body LIKE 'RUN OUT MISSED!%')::int AS missed_run_outs,
                count(*) FILTER (WHERE ce.body LIKE 'MISFIELD!%')::int AS misfields
         FROM commentary_entries ce
         JOIN innings i ON i.id = ce.innings_id
         WHERE i.match_id = $1 AND ce.fielder_player_id IS NOT NULL
         GROUP BY ce.fielder_player_id
       ),
       scored AS (
         SELECT pms.match_id, pms.player_id,
                pms.runs_scored + pms.fours * 0.5 + pms.sixes * 1
                + CASE WHEN ov.o <= 20 THEN
                        CASE WHEN pms.runs_scored >= 3 * ov.o THEN 16
                             WHEN pms.runs_scored >= 2.5 * ov.o THEN 12
                             WHEN pms.runs_scored >= 2 * ov.o THEN 8
                             WHEN pms.runs_scored >= 1.5 * ov.o THEN 4
                             ELSE 0 END
                       ELSE
                        CASE WHEN pms.runs_scored >= 2 * ov.o THEN 16
                             WHEN pms.runs_scored >= 1.6 * ov.o THEN 12
                             WHEN pms.runs_scored >= 1.4 * ov.o THEN 8
                             WHEN pms.runs_scored >= 1 * ov.o THEN 4
                             ELSE 0 END
                       END
                + CASE WHEN pms.batted AND pms.balls_faced > 0
                       THEN greatest(-8, least(8,
                            (pms.runs_scored - pms.balls_faced * mrr.rr / 6) * 0.5))
                       ELSE 0 END
                + CASE WHEN ov.o > 0 THEN pms.runs_scored::numeric / ov.o
                       ELSE 0 END AS batting,
                pms.wickets_taken * 6 + pms.maidens * 4 + pms.dot_balls * 0.25
                + CASE WHEN pms.wickets_taken >= 5 THEN 14
                       WHEN pms.wickets_taken = 4 THEN 10
                       WHEN pms.wickets_taken = 3 THEN 6
                       WHEN pms.wickets_taken = 2 THEN 3
                       ELSE 0 END
                + CASE WHEN pms.balls_bowled > 0
                       THEN greatest(-8, least(8,
                            (pms.balls_bowled * mrr.rr / 6 - pms.runs_conceded) * 0.5))
                       ELSE 0 END
                + coalesce(bw.victim_value, 0) AS bowling,
                pms.catches * 6 + pms.stumpings * 8 + pms.run_outs * 8
                - coalesce(fe.dropped_catches, 0) * 3
                - coalesce(fe.missed_run_outs, 0) * 2
                - coalesce(fe.misfields, 0) * 1 AS fielding,
                CASE WHEN m.winner_team_id IS NOT NULL AND pms.team_id = m.winner_team_id
                     THEN 1.1 ELSE 1.0 END AS win_factor
         FROM player_match_stats pms
         JOIN matches m ON m.id = pms.match_id
         CROSS JOIN mrr
         CROSS JOIN ov
         LEFT JOIN big_wickets bw ON bw.player_id = pms.player_id
         LEFT JOIN fielding_errors fe ON fe.player_id = pms.player_id
         WHERE pms.match_id = $1
       )
       INSERT INTO match_mvp_points (match_id, player_id, batting_points, bowling_points, fielding_points, total_points)
       SELECT match_id, player_id,
              round(batting * win_factor, 2),
              round(bowling * win_factor, 2),
              round(fielding * win_factor, 2),
              round((batting + bowling + fielding) * win_factor, 2)
       FROM scored`,
      [matchId],
    );

    // Update player of match if not set
    await client.query(
      `UPDATE matches SET player_of_match_id = (
         SELECT player_id FROM match_mvp_points WHERE match_id = $1
         ORDER BY batting_points + bowling_points + fielding_points DESC LIMIT 1)
       WHERE id = $1 AND player_of_match_id IS NULL AND status = 'completed'`,
      [matchId],
    );

    // Add MOTM bonus
    await client.query(
      `UPDATE match_mvp_points mmp
          SET total_points = round(mmp.total_points + 3 *
              CASE WHEN m.winner_team_id IS NOT NULL AND pms.team_id = m.winner_team_id
                   THEN 1.1 ELSE 1.0 END, 2)
       FROM matches m
       JOIN player_match_stats pms
         ON pms.match_id = m.id AND pms.player_id = m.player_of_match_id
       WHERE m.id = mmp.match_id AND mmp.match_id = $1
         AND m.player_of_match_id = mmp.player_id`,
      [matchId],
    );

    // Update player_match_stats with new MVP points
    await client.query(
      `UPDATE player_match_stats pms SET mvp_points = mmp.total_points
       FROM match_mvp_points mmp
       WHERE mmp.match_id = pms.match_id AND mmp.player_id = pms.player_id AND pms.match_id = $1`,
      [matchId],
    );

    // Rebuild tournament stats if applicable
    if (match.tournament_id) {
      await client.query(`DELETE FROM player_tournament_stats WHERE tournament_id = $1`, [match.tournament_id]);
      await client.query(
        `INSERT INTO player_tournament_stats (tournament_id, player_id, team_id, matches_played,
           innings_batted, runs_scored, balls_faced, not_outs, highest_score, highest_score_not_out,
           fifties, hundreds, fours, sixes, ducks,
           innings_bowled, balls_bowled, runs_conceded, wickets_taken, best_bowling,
           three_wkt_hauls, five_wkt_hauls, maidens, catches, stumpings, run_outs, mvp_points)
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
                sum(fours)::int, sum(sixes)::int,
                count(*) FILTER (WHERE batted AND is_out AND runs_scored = 0)::int,
                count(*) FILTER (WHERE bowled)::int,
                sum(balls_bowled)::int, sum(runs_conceded)::int, sum(wickets_taken)::int,
                (SELECT jsonb_build_object('wickets', p3.wickets_taken, 'runs', p3.runs_conceded)
                 FROM player_match_stats p3
                 WHERE p3.tournament_id = pms.tournament_id AND p3.player_id = pms.player_id AND p3.bowled
                 ORDER BY p3.wickets_taken DESC, p3.runs_conceded ASC LIMIT 1),
                count(*) FILTER (WHERE wickets_taken >= 3 AND wickets_taken < 5)::int,
                count(*) FILTER (WHERE wickets_taken >= 5)::int,
                sum(maidens)::int, sum(catches)::int, sum(stumpings)::int, sum(run_outs)::int,
                sum(mvp_points)
         FROM player_match_stats pms
         WHERE tournament_id = $1
         GROUP BY tournament_id, player_id`,
        [match.tournament_id],
      );
    }

    // Rebuild career stats
    const players = (
      await client.query(`SELECT DISTINCT player_id FROM player_match_stats WHERE match_id = $1`, [matchId])
    ).rows;

    for (const { player_id } of players) {
      await client.query(`DELETE FROM player_career_stats WHERE player_id = $1`, [player_id]);
      await client.query(
        `INSERT INTO player_career_stats (player_id, format_family, matches_played, innings_batted,
           runs_scored, balls_faced, not_outs, highest_score, fifties, hundreds, fours, sixes,
           innings_bowled, balls_bowled, runs_conceded, wickets_taken, best_bowling, five_wkt_hauls,
           catches, stumpings, run_outs)
         SELECT pms.player_id,
                CASE coalesce(f.slug::text, 'custom')
                  WHEN 't20' THEN 't20' WHEN 'odi' THEN 'one_day' WHEN 't10' THEN 't10'
                  WHEN 'sixes' THEN 'sixes' WHEN 'test' THEN 'test' ELSE 'custom' END AS family,
                count(*)::int, count(*) FILTER (WHERE pms.batted)::int,
                sum(pms.runs_scored)::int, sum(pms.balls_faced)::int,
                count(*) FILTER (WHERE pms.batted AND NOT pms.is_out)::int,
                coalesce(max(pms.runs_scored),0)::int,
                count(*) FILTER (WHERE pms.runs_scored BETWEEN 50 AND 99)::int,
                count(*) FILTER (WHERE pms.runs_scored >= 100)::int,
                sum(pms.fours)::int, sum(pms.sixes)::int,
                count(*) FILTER (WHERE pms.bowled)::int,
                sum(pms.balls_bowled)::int, sum(pms.runs_conceded)::int, sum(pms.wickets_taken)::int,
                (SELECT jsonb_build_object('wickets', p3.wickets_taken, 'runs', p3.runs_conceded)
                 FROM player_match_stats p3 WHERE p3.player_id = pms.player_id AND p3.bowled
                 ORDER BY p3.wickets_taken DESC, p3.runs_conceded ASC LIMIT 1),
                count(*) FILTER (WHERE pms.wickets_taken >= 5)::int,
                sum(pms.catches)::int, sum(pms.stumpings)::int, sum(pms.run_outs)::int
         FROM player_match_stats pms
         JOIN matches m ON m.id = pms.match_id
         LEFT JOIN tournaments t ON t.id = m.tournament_id
         LEFT JOIN match_formats f ON f.id = t.format_id
         WHERE pms.player_id = $1
         GROUP BY pms.player_id, family`,
        [player_id],
      );
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log(`· dry-run (rolled back) ${matchId}`);
      return true;
    }
    await client.query('COMMIT');
    console.log(`✓ Recalculated MVP for match ${matchId}`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`✗ Error recalculating MVP for match ${matchId}:`, err.message);
    return false;
  }
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('Fetching all completed matches...');
    const result = await client.query(
      `SELECT id FROM matches WHERE status = 'completed' ORDER BY completed_at DESC`,
    );
    const matches = result.rows;
    console.log(`Found ${matches.length} completed matches\n`);

    if (matches.length === 0) {
      console.log('No matches to recalculate.');
      return;
    }

    let ok = 0;
    let failed = 0;
    for (let i = 0; i < matches.length; i++) {
      const { id } = matches[i];
      process.stdout.write(`[${i + 1}/${matches.length}] `);
      if (await recalculateMvpForMatch(client, id)) ok++;
      else failed++;
    }

    console.log(`\n${DRY_RUN ? 'DRY RUN — nothing written. ' : ''}Succeeded ${ok}, failed ${failed}, of ${matches.length}`);
    if (failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
