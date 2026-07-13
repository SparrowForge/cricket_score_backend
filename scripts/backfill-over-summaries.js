/**
 * Backfill "End of over N" auto-commentary for matches scored BEFORE the
 * over-summary feature existed (added 2026-07-13). Idempotent: skips any
 * over that already has an "End of over N:" entry for its innings.
 *
 * Also recomputes over_summaries.is_maiden with the corrected rule (byes/
 * leg-byes don't break a maiden; wide/no-ball penalties do), since old rows
 * were flagged with the pre-fix logic.
 *
 * Usage:
 *   node scripts/backfill-over-summaries.js           # dry run (prints, no writes)
 *   node scripts/backfill-over-summaries.js --apply   # write to the DB
 */
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BOWLER_CREDITED = new Set([
  'bowled', 'caught', 'caught_behind', 'caught_and_bowled', 'lbw', 'stumped',
  'hit_wicket', 'hit_ball_twice', 'handled_ball',
]);

async function main() {
  const innings = (
    await pool.query(`
      SELECT i.id, i.match_id, m.rules_snapshot
      FROM innings i JOIN matches m ON m.id = i.match_id
      ORDER BY i.match_id, i.seq`)
  ).rows;

  let inserted = 0, maidenFixes = 0;
  for (const inn of innings) {
    const bpo = inn.rules_snapshot?.balls_per_over ?? 6;
    const balls = (
      await pool.query(
        `SELECT b.*, sp.full_name AS striker_name, np.full_name AS non_striker_name,
                bp.full_name AS bowler_name
         FROM balls b
         JOIN players sp ON sp.id = b.striker_id
         JOIN players np ON np.id = b.non_striker_id
         JOIN players bp ON bp.id = b.bowler_id
         WHERE b.innings_id = $1 AND NOT b.is_superseded ORDER BY b.seq`,
        [inn.id],
      )
    ).rows;
    if (!balls.length) continue;

    const existing = new Set(
      (
        await pool.query(
          `SELECT body FROM commentary_entries
           WHERE innings_id = $1 AND source = 'auto' AND body LIKE 'End of over %'`,
          [inn.id],
        )
      ).rows.map((r) => Number(r.body.match(/^End of over (\d+):/)?.[1])),
    );

    // Replay: running totals + per-batter/per-bowler cards, over by over.
    let totalRuns = 0, totalWickets = 0, legalInOver = 0;
    const batters = {}; // id -> {name, runs, balls}
    const bowlers = {}; // id -> {name, legal, runs, wickets, maidens}
    const names = {};
    let overBalls = [];

    for (const b of balls) {
      names[b.striker_id] = b.striker_name;
      names[b.non_striker_id] = b.non_striker_name;
      const bat = (batters[b.striker_id] ??= { runs: 0, balls: 0 });
      const bowl = (bowlers[b.bowler_id] ??= { name: b.bowler_name, legal: 0, runs: 0, wickets: 0, maidens: 0 });

      totalRuns += b.runs_batter + b.runs_extras;
      if (b.is_wicket && b.wicket_type !== 'retired_hurt') totalWickets += 1;
      if (b.extra_type !== 'wide') bat.balls += 1;
      bat.runs += b.runs_batter;
      if (b.is_legal) { bowl.legal += 1; legalInOver += 1; }
      bowl.runs += b.runs_batter
        + (['wide', 'no_ball'].includes(b.extra_type ?? '') ? b.runs_extras - (b.secondary_extra_runs ?? 0) : 0);
      if (b.is_wicket && BOWLER_CREDITED.has(b.wicket_type)) bowl.wickets += 1;
      overBalls.push(b);

      if (legalInOver === bpo) {
        // Over complete — bowler-charged runs & wickets for THIS over
        const overRuns = overBalls.reduce(
          (s, x) => s + x.runs_batter
            + (['wide', 'no_ball'].includes(x.extra_type ?? '') ? x.runs_extras - (x.secondary_extra_runs ?? 0) : 0),
          0,
        );
        const overWkts = overBalls.filter((x) => x.is_wicket && BOWLER_CREDITED.has(x.wicket_type)).length;
        const isMaiden = overRuns === 0;
        const isWicketMaiden = isMaiden && overWkts > 0;
        if (isMaiden) bowl.maidens += 1;
        const overNumber = overBalls[0].over_number;

        // Keep over_summaries.is_maiden consistent with the corrected rule
        const cur = (
          await pool.query(
            `SELECT is_maiden FROM over_summaries WHERE innings_id = $1 AND over_number = $2`,
            [inn.id, overNumber],
          )
        ).rows[0];
        if (cur && cur.is_maiden !== isMaiden) {
          maidenFixes += 1;
          if (APPLY) {
            await pool.query(
              `UPDATE over_summaries SET is_maiden = $3 WHERE innings_id = $1 AND over_number = $2`,
              [inn.id, overNumber, isMaiden],
            );
          }
        }

        if (!existing.has(overNumber + 1)) {
          // Striker/non-striker AFTER the over: prefer the recorded openers of
          // the next over (ground truth); fall back to the last ball's pair.
          const last = overBalls[overBalls.length - 1];
          const idx = balls.indexOf(last);
          const nextBall = balls[idx + 1];
          const [sId, nId] = nextBall
            ? [nextBall.striker_id, nextBall.non_striker_id]
            : [last.non_striker_id, last.striker_id]; // over-end swap
          const sc = batters[sId] ?? { runs: 0, balls: 0 };
          const nc = batters[nId] ?? { runs: 0, balls: 0 };
          const figures = `${Math.floor(bowl.legal / bpo)}.${bowl.legal % bpo}-${bowl.maidens}-${bowl.runs}-${bowl.wickets}`;
          const body =
            `End of over ${overNumber + 1}: ${totalRuns}/${totalWickets}. ` +
            (isWicketMaiden ? 'WICKET MAIDEN! ' : isMaiden ? 'Maiden over! ' : '') +
            `${names[sId] ?? 'Batter'} ${sc.runs}(${sc.balls}), ${names[nId] ?? 'Batter'} ${nc.runs}(${nc.balls}). ` +
            `${bowl.name} ${figures}`;
          inserted += 1;
          console.log(`[${APPLY ? 'INSERT' : 'dry'}] innings ${inn.id.slice(0, 8)} over ${overNumber + 1}: ${body}`);
          if (APPLY) {
            await pool.query(
              `INSERT INTO commentary_entries (match_id, innings_id, ball_id, source, body, is_highlight, created_at)
               VALUES ($1, $2, $3, 'auto', $4, $5, $6::timestamptz + interval '1 millisecond')`,
              [inn.match_id, inn.id, last.id, body, isMaiden, last.created_at],
            );
          }
        }
        legalInOver = 0;
        overBalls = [];
      }
    }
  }
  console.log(`\n${APPLY ? 'Inserted' : 'Would insert'} ${inserted} over-summary entries; ` +
    `${APPLY ? 'fixed' : 'would fix'} ${maidenFixes} is_maiden flags.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
