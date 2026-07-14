import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';

/**
 * Stats pipeline, run synchronously on match completion (no worker tier yet).
 * Everything is a rebuild (idempotent) rather than an increment, so re-running
 * finalize after corrections always converges to the truth in `balls`.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async finalizeMatch(matchId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const match = (await client.query(`SELECT * FROM matches WHERE id = $1`, [matchId])).rows[0];
      if (!match) return;

      await this.buildPlayerMatchStats(client, match);
      await this.buildMvpPoints(client, matchId);
      if (match.tournament_id) {
        await this.rebuildTournamentStats(client, match.tournament_id);
        await this.rebuildPointsTable(client, match.tournament_id);
      }
      await this.rebuildCareerStats(client, matchId);
      await this.updateHeadToHead(client, match);
      await this.notifyFollowers(client, match);
      await client.query('COMMIT');
      this.logger.log(`Stats finalized for match ${matchId}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- per-match facts ----------
  private async buildPlayerMatchStats(client: PoolClient, match: any) {
    await client.query(`DELETE FROM player_match_stats WHERE match_id = $1`, [match.id]);
    await client.query(
      `WITH b AS (
         SELECT b.*, i.batting_team_id, i.bowling_team_id
         FROM balls b JOIN innings i ON i.id = b.innings_id
         WHERE i.match_id = $1 AND NOT b.is_superseded
       ),
       batting AS (
         SELECT striker_id AS player_id, batting_team_id AS team_id,
                sum(runs_batter)::int AS runs,
                count(*) FILTER (WHERE extra_type IS DISTINCT FROM 'wide')::int AS balls,
                count(*) FILTER (WHERE is_boundary_four)::int AS fours,
                count(*) FILTER (WHERE is_boundary_six)::int AS sixes,
                min(seq) AS first_ball
         FROM b GROUP BY striker_id, batting_team_id
       ),
       dismissals AS (
         SELECT dismissed_player_id AS player_id, max(wicket_type::text) AS wicket_type
         FROM b WHERE is_wicket AND wicket_type <> 'retired_hurt' GROUP BY dismissed_player_id
       ),
       bowling AS (
         SELECT bowler_id AS player_id, bowling_team_id AS team_id,
                count(*) FILTER (WHERE is_legal)::int AS balls_bowled,
                sum(runs_batter + CASE WHEN extra_type IN ('wide','no_ball') THEN runs_extras - secondary_extra_runs ELSE 0 END)::int AS runs_conceded,
                count(*) FILTER (WHERE is_wicket AND wicket_type NOT IN ('run_out','retired_hurt','retired_out','obstructing_field','timed_out'))::int AS wickets,
                count(*) FILTER (WHERE extra_type = 'wide')::int AS wides,
                count(*) FILTER (WHERE extra_type = 'no_ball')::int AS no_balls,
                count(*) FILTER (WHERE is_legal AND runs_batter = 0 AND runs_extras = 0)::int AS dots
         FROM b GROUP BY bowler_id, bowling_team_id
       ),
       maidens AS (
         SELECT bowler_id AS player_id, count(*)::int AS maidens
         FROM over_summaries os JOIN innings i ON i.id = os.innings_id
         WHERE i.match_id = $1 AND os.is_maiden GROUP BY bowler_id
       ),
       fielding AS (
         SELECT fielder_id AS player_id, bowling_team_id AS team_id,
                count(*) FILTER (WHERE wicket_type IN ('caught','caught_behind'))::int AS catches,
                count(*) FILTER (WHERE wicket_type = 'stumped')::int AS stumpings,
                count(*) FILTER (WHERE wicket_type = 'run_out')::int AS run_outs
         FROM b WHERE fielder_id IS NOT NULL GROUP BY fielder_id, bowling_team_id
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
       all_players AS (
         SELECT player_id, team_id FROM batting
         UNION SELECT player_id, team_id FROM bowling
         UNION SELECT player_id, team_id FROM fielding
       )
       INSERT INTO player_match_stats (match_id, tournament_id, player_id, team_id,
         batted, runs_scored, balls_faced, fours, sixes, is_out, dismissal_type, batting_position,
         bowled, balls_bowled, runs_conceded, wickets_taken, maidens, wides_bowled, no_balls_bowled, dot_balls,
         catches, stumpings, run_outs)
       SELECT $1, $2, ap.player_id, ap.team_id,
              bat.player_id IS NOT NULL, coalesce(bat.runs,0), coalesce(bat.balls,0),
              coalesce(bat.fours,0), coalesce(bat.sixes,0),
              d.player_id IS NOT NULL, d.wicket_type::wicket_type, NULL,
              bo.player_id IS NOT NULL, coalesce(bo.balls_bowled,0), coalesce(bo.runs_conceded,0),
              coalesce(bo.wickets,0), coalesce(m.maidens,0), coalesce(bo.wides,0), coalesce(bo.no_balls,0), coalesce(bo.dots,0),
              coalesce(f.catches,0), coalesce(f.stumpings,0), coalesce(f.run_outs,0)
       FROM all_players ap
       LEFT JOIN batting bat ON bat.player_id = ap.player_id AND bat.team_id = ap.team_id
       LEFT JOIN dismissals d ON d.player_id = ap.player_id
       LEFT JOIN bowling bo ON bo.player_id = ap.player_id AND bo.team_id = ap.team_id
       LEFT JOIN maidens m ON m.player_id = ap.player_id
       LEFT JOIN fielding f ON f.player_id = ap.player_id AND f.team_id = ap.team_id`,
      [match.id, match.tournament_id],
    );
  }

  // ---------- MVP ----------
  /**
   * MVP points with match context, not just raw tallies:
   * - batting: runs + boundary bonus + milestone bonus + pace-vs-match-run-rate
   *   impact (runs above/below par for the balls consumed — rewards
   *   match-turning quick runs, discounts slow crawls);
   * - bowling: wickets + maidens + dots + runs saved vs the match run rate
   *   (economy in context) + a match-turning bonus for dismissing a set
   *   batter (scaled by the victim's runs at the fall);
   * - fielding: unchanged;
   * - match-winning effect: every component ×1.1 for the winning team.
   */
  private async buildMvpPoints(client: PoolClient, matchId: string) {
    await client.query(`DELETE FROM match_mvp_points WHERE match_id = $1`, [matchId]);
    await client.query(
      `WITH mrr AS (
         SELECT CASE WHEN sum(legal_balls) > 0
                     THEN sum(total_runs)::numeric * 6 / sum(legal_balls)
                     ELSE 0 END AS rr
         FROM innings WHERE match_id = $1
       ),
       big_wickets AS (
         -- Match-turning bowling: credit for removing a batter who was set,
         -- weighted by the runs the victim had scored at the fall.
         SELECT b.bowler_id AS player_id, sum(victim.runs)::numeric AS victim_runs
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
       scored AS (
         SELECT pms.match_id, pms.player_id,
                greatest(
                  pms.runs_scored + pms.fours * 1 + pms.sixes * 2
                  + CASE WHEN pms.runs_scored >= 100 THEN 16 WHEN pms.runs_scored >= 50 THEN 8 ELSE 0 END
                  + CASE WHEN pms.batted AND pms.balls_faced > 0
                         THEN (pms.runs_scored - pms.balls_faced * mrr.rr / 6) * 0.5
                         ELSE 0 END,
                  0) AS batting,
                greatest(
                  pms.wickets_taken * 20 + pms.maidens * 8 + pms.dot_balls * 0.5
                  + CASE WHEN pms.wickets_taken >= 5 THEN 16 WHEN pms.wickets_taken >= 3 THEN 8 ELSE 0 END
                  + CASE WHEN pms.balls_bowled > 0
                         THEN (pms.balls_bowled * mrr.rr / 6 - pms.runs_conceded) * 0.5
                         ELSE 0 END
                  + coalesce(bw.victim_runs, 0) * 0.4,
                  0) AS bowling,
                greatest(
                  pms.catches * 8 + pms.stumpings * 12 + pms.run_outs * 6
                  - coalesce(fe.dropped_catches, 0) * 4
                  - coalesce(fe.missed_run_outs, 0) * 3
                  - coalesce(fe.misfields, 0) * 2,
                  0) AS fielding,
                CASE WHEN m.winner_team_id IS NOT NULL AND pms.team_id = m.winner_team_id
                     THEN 1.1 ELSE 1.0 END AS win_factor
         FROM player_match_stats pms
         JOIN matches m ON m.id = pms.match_id
         CROSS JOIN mrr
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
    await client.query(
      `UPDATE player_match_stats pms SET mvp_points = mmp.total_points
       FROM match_mvp_points mmp
       WHERE mmp.match_id = pms.match_id AND mmp.player_id = pms.player_id AND pms.match_id = $1`,
      [matchId],
    );
    // Default Man of the Match: top MVP, unless the scorer already chose one.
    await client.query(
      `UPDATE matches SET player_of_match_id = (
         SELECT player_id FROM match_mvp_points WHERE match_id = $1
         ORDER BY total_points DESC LIMIT 1)
       WHERE id = $1 AND player_of_match_id IS NULL AND status = 'completed'`,
      [matchId],
    );
  }

  // ---------- tournament rollup ----------
  private async rebuildTournamentStats(client: PoolClient, tournamentId: string) {
    await client.query(`DELETE FROM player_tournament_stats WHERE tournament_id = $1`, [tournamentId]);
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
      [tournamentId],
    );
  }

  // ---------- points table + NRR ----------
  private async rebuildPointsTable(client: PoolClient, tournamentId: string) {
    const t = (await client.query(`SELECT points_rules FROM tournaments WHERE id = $1`, [tournamentId])).rows[0];
    const pr = t.points_rules ?? { win: 2, loss: 0, tie: 1, no_result: 1 };

    const teams = (
      await client.query(`SELECT team_id, group_id FROM tournament_teams WHERE tournament_id = $1`, [tournamentId])
    ).rows;

    for (const { team_id, group_id } of teams) {
      const agg = (
        await client.query(
          `SELECT
             count(*) FILTER (WHERE m.status = 'completed')::int AS played,
             count(*) FILTER (WHERE m.winner_team_id = $2)::int AS won,
             count(*) FILTER (WHERE m.status = 'completed' AND m.result_type = 'win' AND m.winner_team_id <> $2)::int AS lost,
             count(*) FILTER (WHERE m.result_type = 'tie')::int AS tied,
             count(*) FILTER (WHERE m.result_type IN ('no_result','abandoned'))::int AS no_result
           FROM matches m
           WHERE m.tournament_id = $1 AND (m.team_a_id = $2 OR m.team_b_id = $2)
             AND m.status IN ('completed','abandoned','no_result')`,
          [tournamentId, team_id],
        )
      ).rows[0];

      // NRR: all-out innings count as the full overs quota
      const nrr = (
        await client.query(
          `WITH inns AS (
             SELECT i.*, m.rules_snapshot
             FROM innings i JOIN matches m ON m.id = i.match_id
             WHERE m.tournament_id = $1 AND m.status = 'completed' AND m.result_type = 'win'
           ),
           faced AS (
             SELECT coalesce(sum(total_runs),0)::int AS runs,
                    coalesce(sum(CASE WHEN total_wickets >= coalesce((rules_snapshot->>'wickets_to_fall')::int, 10)
                                      AND max_overs IS NOT NULL
                                 THEN max_overs * coalesce((rules_snapshot->>'balls_per_over')::int, 6)
                                 ELSE legal_balls END),0) AS balls
             FROM inns WHERE batting_team_id = $2
           ),
           bowled AS (
             SELECT coalesce(sum(total_runs),0)::int AS runs,
                    coalesce(sum(CASE WHEN total_wickets >= coalesce((rules_snapshot->>'wickets_to_fall')::int, 10)
                                      AND max_overs IS NOT NULL
                                 THEN max_overs * coalesce((rules_snapshot->>'balls_per_over')::int, 6)
                                 ELSE legal_balls END),0) AS balls
             FROM inns WHERE bowling_team_id = $2
           )
           SELECT f.runs AS runs_for, f.balls AS balls_faced, b.runs AS runs_against, b.balls AS balls_bowled,
                  round(CASE WHEN f.balls > 0 THEN f.runs::numeric * 6 / f.balls ELSE 0 END
                      - CASE WHEN b.balls > 0 THEN b.runs::numeric * 6 / b.balls ELSE 0 END, 3) AS nrr
           FROM faced f, bowled b`,
          [tournamentId, team_id],
        )
      ).rows[0];

      const points = agg.won * (pr.win ?? 2) + agg.tied * (pr.tie ?? 1) + agg.no_result * (pr.no_result ?? 1) + agg.lost * (pr.loss ?? 0);

      await client.query(
        `INSERT INTO points_table_entries (tournament_id, group_id, team_id, played, won, lost, tied, no_result,
                                           points, runs_for, overs_faced, runs_against, overs_bowled, net_run_rate, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (tournament_id, team_id) DO UPDATE SET
           group_id=$2, played=$4, won=$5, lost=$6, tied=$7, no_result=$8, points=$9,
           runs_for=$10, overs_faced=$11, runs_against=$12, overs_bowled=$13, net_run_rate=$14, updated_at=now()`,
        [tournamentId, group_id, team_id, agg.played, agg.won, agg.lost, agg.tied, agg.no_result,
         points, nrr.runs_for, +(nrr.balls_faced / 6).toFixed(1), nrr.runs_against, +(nrr.balls_bowled / 6).toFixed(1), nrr.nrr],
      );
    }

    // Ranks
    await client.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (PARTITION BY group_id ORDER BY points DESC, net_run_rate DESC, won DESC) AS rk
         FROM points_table_entries WHERE tournament_id = $1
       )
       UPDATE points_table_entries pte SET rank = ranked.rk FROM ranked WHERE ranked.id = pte.id`,
      [tournamentId],
    );
  }

  // ---------- career rollup ----------
  private async rebuildCareerStats(client: PoolClient, matchId: string) {
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
  }

  // ---------- head to head ----------
  private async updateHeadToHead(client: PoolClient, match: any) {
    const [a, b] = [match.team_a_id, match.team_b_id].sort();
    await client.query(
      `INSERT INTO team_head_to_head (team_a_id, team_b_id, matches_played, team_a_wins, team_b_wins, ties, no_results, last_five, updated_at)
       SELECT $1, $2,
              count(*)::int,
              count(*) FILTER (WHERE winner_team_id = $1)::int,
              count(*) FILTER (WHERE winner_team_id = $2)::int,
              count(*) FILTER (WHERE result_type = 'tie')::int,
              count(*) FILTER (WHERE result_type IN ('no_result','abandoned'))::int,
              coalesce((SELECT jsonb_agg(jsonb_build_object('match_id', m2.id, 'winner', m2.winner_team_id, 'summary', m2.result_summary))
               FROM (SELECT * FROM matches
                     WHERE ((team_a_id = $1 AND team_b_id = $2) OR (team_a_id = $2 AND team_b_id = $1))
                       AND status = 'completed' ORDER BY completed_at DESC LIMIT 5) m2), '[]'::jsonb),
              now()
       FROM matches
       WHERE ((team_a_id = $1 AND team_b_id = $2) OR (team_a_id = $2 AND team_b_id = $1))
         AND status IN ('completed','abandoned','no_result')
       ON CONFLICT (team_a_id, team_b_id) DO UPDATE SET
         matches_played = excluded.matches_played, team_a_wins = excluded.team_a_wins,
         team_b_wins = excluded.team_b_wins, ties = excluded.ties, no_results = excluded.no_results,
         last_five = excluded.last_five, updated_at = now()`,
      [a, b],
    );
  }

  // ---------- in-app notifications ----------
  /** Result notification for everyone following the match, either team, or the tournament. */
  private async notifyFollowers(client: PoolClient, match: any) {
    if (!match.result_summary && match.status !== 'completed') return;
    const teams = (
      await client.query(
        `SELECT ta.name AS a, tb.name AS b FROM matches m
         JOIN teams ta ON ta.id = m.team_a_id JOIN teams tb ON tb.id = m.team_b_id WHERE m.id = $1`,
        [match.id],
      )
    ).rows[0];
    const result = (await client.query(`SELECT result_summary FROM matches WHERE id = $1`, [match.id])).rows[0];
    await client.query(
      `INSERT INTO notifications (user_id, channel, event_type, title, body, data, sent_at)
       SELECT DISTINCT uf.user_id, 'in_app'::notification_channel, 'match.result', $2, $3,
              jsonb_build_object('match_id', $1::uuid, 'tournament_id', $4::uuid), now()
       FROM user_follows uf
       WHERE (uf.entity_type = 'match' AND uf.entity_id = $1)
          OR (uf.entity_type = 'team' AND uf.entity_id IN ($5, $6))
          OR (uf.entity_type = 'tournament' AND $4::uuid IS NOT NULL AND uf.entity_id = $4)
       ON CONFLICT DO NOTHING`,
      [match.id, `${teams.a} vs ${teams.b} — result`, result?.result_summary ?? 'Match completed',
       match.tournament_id, match.team_a_id, match.team_b_id],
    );
  }

  // ---------- public reads ----------
  async leaderboard(tournamentId: string, metric: string) {
    const order: Record<string, string> = {
      runs: 'runs_scored DESC, strike_rate DESC',
      wickets: 'wickets_taken DESC, economy ASC',
      mvp: 'mvp_points DESC',
      sr: 'strike_rate DESC NULLS LAST',
      economy: 'economy ASC NULLS LAST',
    };
    return (
      await this.pool.query(
        `SELECT * FROM v_player_tournament_leaderboard WHERE tournament_id = $1
         ORDER BY ${order[metric] ?? order.runs} LIMIT 50`,
        [tournamentId],
      )
    ).rows;
  }

  async headToHead(teamA: string, teamB: string) {
    const [a, b] = [teamA, teamB].sort();
    const res = await this.pool.query(
      `SELECT * FROM team_head_to_head WHERE team_a_id = $1 AND team_b_id = $2`,
      [a, b],
    );
    return res.rows[0] ?? { team_a_id: a, team_b_id: b, matches_played: 0 };
  }
}
