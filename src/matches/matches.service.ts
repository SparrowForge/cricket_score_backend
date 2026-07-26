import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { LiveStateService } from './live-state.service';
import { StatsService } from './stats.service';

// GET /matches/:id cache TTL. The key embeds the live-state seq, so a scored
// ball always misses to a fresh key; the TTL only bounds staleness for
// non-scoring edits (venue, officials, squad).
const DETAIL_CACHE_TTL_S = 15;

/** Scorecard dismissal line: 'caught Dhoni bowled Jadeja' | 'caught & bowled Jadeja' | 'run out Jadeja' | 'bowled Bumrah' … */
type WicketRow = {
  dismissed_player_id: string;
  wicket_type: string;
  bowler_id: string;
  fielder_id: string | null;
  bowler_name: string;
  fielder_name: string | null;
};

function dismissalText(w: Pick<WicketRow, 'wicket_type' | 'bowler_id' | 'fielder_id' | 'bowler_name' | 'fielder_name'>): string {
  switch (w.wicket_type) {
    case 'caught':
    case 'caught_behind':
      // Bowler taking his own catch is caught & bowled even if scored as plain 'caught'.
      return w.fielder_id && w.fielder_id !== w.bowler_id
        ? `caught ${w.fielder_name} bowled ${w.bowler_name}`
        : `caught & bowled ${w.bowler_name}`;
    case 'caught_and_bowled':
      return `caught & bowled ${w.bowler_name}`;
    case 'bowled':
      return `bowled ${w.bowler_name}`;
    case 'lbw':
      return `lbw bowled ${w.bowler_name}`;
    case 'stumped':
      return w.fielder_name ? `stumped ${w.fielder_name} bowled ${w.bowler_name}` : `stumped bowled ${w.bowler_name}`;
    case 'hit_wicket':
      return `hit wicket bowled ${w.bowler_name}`;
    case 'run_out':
      return w.fielder_name ? `run out ${w.fielder_name}` : 'run out';
    default:
      return w.wicket_type.replace(/_/g, ' ');
  }
}

export function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || typeof override !== 'object' || Array.isArray(base) || Array.isArray(override)) {
    return override;
  }
  const out: any = { ...base };
  for (const key of Object.keys(override)) out[key] = deepMerge(base?.[key], override[key]);
  return out;
}

@Injectable()
export class MatchesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly live: LiveStateService,
    private readonly stats: StatsService,
  ) {}

  async list(filter: { tournament?: string; org?: string; status?: string }) {
    return (
      await this.pool.query(
        `SELECT m.id, m.match_number, m.stage, m.stage_label, m.status, m.scheduled_start,
                m.result_summary, m.tournament_id, m.winner_team_id,
                m.toss_winner_id, m.toss_decision,
                ta.id AS team_a_id, ta.name AS team_a, ta.short_name AS team_a_short, ta.logo_url AS team_a_logo,
                tb.id AS team_b_id, tb.name AS team_b, tb.short_name AS team_b_short, tb.logo_url AS team_b_logo,
                v.name AS venue, t.name AS tournament_name,
                m.live_state->'summary' AS live_summary,
                coalesce((m.rules_snapshot->>'wickets_to_fall')::int, 10) AS wickets_to_fall,
                ia.total_runs AS team_a_runs, ia.total_wickets AS team_a_wickets, ia.legal_balls AS team_a_balls,
                ib.total_runs AS team_b_runs, ib.total_wickets AS team_b_wickets, ib.legal_balls AS team_b_balls
         FROM matches m
         JOIN teams ta ON ta.id = m.team_a_id
         JOIN teams tb ON tb.id = m.team_b_id
         LEFT JOIN venues v ON v.id = m.venue_id
         LEFT JOIN tournaments t ON t.id = m.tournament_id
         LEFT JOIN LATERAL (
           SELECT total_runs, total_wickets, legal_balls FROM innings
           WHERE match_id = m.id AND batting_team_id = m.team_a_id
           ORDER BY seq DESC LIMIT 1
         ) ia ON true
         LEFT JOIN LATERAL (
           SELECT total_runs, total_wickets, legal_balls FROM innings
           WHERE match_id = m.id AND batting_team_id = m.team_b_id
           ORDER BY seq DESC LIMIT 1
         ) ib ON true
         WHERE ($1::uuid IS NULL OR m.tournament_id = $1)
           AND ($2::uuid IS NULL OR m.organization_id = $2)
           AND ($3::text IS NULL OR m.status::text = $3)
         ORDER BY m.scheduled_start DESC LIMIT 100`,
        [filter.tournament ?? null, filter.org ?? null, filter.status ?? null],
      )
    ).rows;
  }

  /**
   * Create a match. When `format_id` is given, resolve the format's rule
   * document, deep-merge `rule_overrides` (e.g. custom overs, free-hit
   * on/off, max overs per bowler) onto it, and freeze the result as
   * `rules_snapshot` right away — `toss()` already prefers an existing
   * `rules_snapshot` over the tournament's format, so this is how a
   * standalone friendly (or a one-off tournament match) gets its own rules
   * without needing a tournament at all.
   */
  async createManual(orgId: string, dto: any) {
    // Every scheduled match must belong to a tournament in the same org
    // (super-over children are created internally and bypass this method).
    const tournament = (
      await this.pool.query(
        `SELECT id FROM tournaments WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [dto.tournament_id, orgId],
      )
    ).rows[0];
    if (!tournament) throw new BadRequestException('tournament_id must reference a tournament in this organization');

    // Both sides must be attached to the tournament — the points table and
    // stats rollups only cover tournament_teams, so an unattached team's
    // results would silently vanish from the standings.
    for (const teamId of [dto.team_a_id, dto.team_b_id]) {
      const attached = await this.pool.query(
        `SELECT 1 FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2`,
        [dto.tournament_id, teamId],
      );
      if (attached.rowCount === 0) {
        const name = (await this.pool.query(`SELECT name FROM teams WHERE id = $1`, [teamId])).rows[0]?.name ?? teamId;
        throw new BadRequestException(`${name} is not part of this tournament — attach it in the tournament setup first`);
      }
    }

    let rulesSnapshot: string | null = null;
    if (dto.format_id) {
      const format = (
        await this.pool.query(`SELECT rules FROM match_formats WHERE id = $1`, [dto.format_id])
      ).rows[0];
      if (!format) throw new BadRequestException('Unknown format_id');
      rulesSnapshot = JSON.stringify(deepMerge(format.rules, dto.rule_overrides ?? {}));
    }

    const res = await this.pool.query(
      `INSERT INTO matches (tournament_id, organization_id, match_number, stage, stage_label, group_id,
                            team_a_id, team_b_id, venue_id, scheduled_start, rules_snapshot)
       VALUES ($1,$2,$3, coalesce($4,'league')::fixture_stage, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [dto.tournament_id, orgId, dto.match_number ?? null, dto.stage ?? null, dto.stage_label ?? null,
       dto.group_id ?? null, dto.team_a_id, dto.team_b_id, dto.venue_id ?? null, dto.scheduled_start, rulesSnapshot],
    );
    return res.rows[0];
  }

  async get(id: string) {
    // Viewers refetch on every ball; collapse that read storm onto Redis.
    // Best-effort: any Redis failure falls through to Postgres.
    let cacheKey: string | null = null;
    try {
      const state = await this.redis.get(`match:${id}:state`);
      if (state) {
        cacheKey = `match:${id}:detail:${JSON.parse(state).seq ?? 0}`;
        const hit = await this.redis.get(cacheKey);
        if (hit) return JSON.parse(hit);
      }
    } catch { /* serve from Postgres */ }

    const m = (
      await this.pool.query(
        `SELECT m.*, ta.name AS team_a_name, ta.short_name AS team_a_short, ta.logo_url AS team_a_logo,
                tb.name AS team_b_name, tb.short_name AS team_b_short, tb.logo_url AS team_b_logo,
                v.name AS venue_name, t.name AS tournament_name, t.slug AS tournament_slug,
                pom.full_name AS player_of_match_name
         FROM matches m
         JOIN teams ta ON ta.id = m.team_a_id
         JOIN teams tb ON tb.id = m.team_b_id
         LEFT JOIN venues v ON v.id = m.venue_id
         LEFT JOIN tournaments t ON t.id = m.tournament_id
         LEFT JOIN players pom ON pom.id = m.player_of_match_id
         WHERE m.id = $1`,
        [id],
      )
    ).rows[0];
    if (!m) throw new NotFoundException('Match not found');
    m.innings = (
      await this.pool.query(
        `SELECT i.*, bt.short_name AS batting_team, bw.short_name AS bowling_team
         FROM innings i JOIN teams bt ON bt.id = i.batting_team_id JOIN teams bw ON bw.id = i.bowling_team_id
         WHERE i.match_id = $1 ORDER BY i.seq`,
        [id],
      )
    ).rows;
    // Super-over lineage: tied parents expose their tie-breaker children
    m.child_matches = (
      await this.pool.query(
        `SELECT id, stage_label, status, result_summary, winner_team_id, scheduled_start
         FROM matches WHERE parent_match_id = $1 ORDER BY scheduled_start`,
        [id],
      )
    ).rows;
    m.officials = (
      await this.pool.query(
        `SELECT mo.duty, o.id, o.full_name, o.official_type
         FROM match_officials mo JOIN officials o ON o.id = mo.official_id
         WHERE mo.match_id = $1 ORDER BY mo.duty`,
        [id],
      )
    ).rows;
    if (cacheKey) {
      void this.redis.set(cacheKey, JSON.stringify(m), 'EX', DETAIL_CACHE_TTL_S).catch(() => {});
    }
    return m;
  }

  /** Replace the match officials panel (umpires / TV umpire / referee / scorer). */
  async setOfficials(matchId: string, officials: { official_id: string; duty: string }[]) {
    const duties = officials.map((o) => o.duty);
    if (new Set(duties).size !== duties.length) throw new BadRequestException('Duplicate duty assignments');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM match_officials WHERE match_id = $1`, [matchId]);
      for (const o of officials) {
        await client.query(
          `INSERT INTO match_officials (match_id, official_id, duty) VALUES ($1,$2,$3)`,
          [matchId, o.official_id, o.duty],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { set: officials.length };
  }

  /**
   * Substitution (12th man / concussion / impact player). Marks the outgoing
   * player and activates the incoming one with explicit bat/bowl eligibility.
   */
  async substitute(
    matchId: string,
    dto: { team_id: string; out_player_id: string; in_player_id: string; reason?: string; can_bat?: boolean; can_bowl?: boolean },
  ) {
    const out = await this.pool.query(
      `UPDATE match_players SET substituted_out_at = now(), is_playing_xi = false
       WHERE match_id = $1 AND team_id = $2 AND player_id = $3 AND substituted_out_at IS NULL
       RETURNING id`,
      [matchId, dto.team_id, dto.out_player_id],
    );
    if (out.rowCount === 0) throw new BadRequestException('Outgoing player is not an active member of this match squad');
    const inRow = await this.pool.query(
      `INSERT INTO match_players (match_id, team_id, player_id, is_playing_xi, is_twelfth, can_bat, can_bowl,
                                  substituted_in_at, substitution_reason, replaced_player_id)
       VALUES ($1,$2,$3, true, false, coalesce($4,true), coalesce($5,true), now(), coalesce($6,'substitute'), $7)
       ON CONFLICT (match_id, player_id) DO UPDATE SET
         is_playing_xi = true, can_bat = coalesce($4,true), can_bowl = coalesce($5,true),
         substituted_in_at = now(), substituted_out_at = NULL,
         substitution_reason = coalesce($6,'substitute'), replaced_player_id = $7
       RETURNING *`,
      [matchId, dto.team_id, dto.in_player_id, dto.can_bat, dto.can_bowl, dto.reason, dto.out_player_id],
    );
    return inRow.rows[0];
  }

  /** Edit match details (scheduled_start, format, rules) before toss. */
  async editMatch(
    matchId: string,
    dto: { scheduled_start?: string; format_id?: string; rule_overrides?: unknown },
  ) {
    const match = (await this.pool.query('SELECT status, tournament_id, rules_snapshot FROM matches WHERE id = $1', [matchId])).rows[0];
    if (!match) throw new NotFoundException('Match not found');
    if (match.status !== 'scheduled') {
      throw new BadRequestException(`Cannot edit match after scheduling (status: ${match.status})`);
    }

    // Prepare the updates. NOTE: `matches` has no `format_id` column — a match's
    // format lives entirely in its rules_snapshot. So picking a new format_id
    // means loading that format's rules and using them as the new base, rather
    // than storing a column.
    const updates: string[] = [];
    const values: unknown[] = [matchId];
    let paramIdx = 2;

    if (dto.scheduled_start) {
      updates.push(`scheduled_start = $${paramIdx}`);
      values.push(dto.scheduled_start);
      paramIdx += 1;
    }

    // Recompute rules_snapshot whenever the format or any override changes.
    if (dto.format_id || dto.rule_overrides) {
      // Base rules, in priority order: an explicitly chosen format, else the
      // match's current snapshot, else the tournament's format, else plain T20.
      let baseRules: unknown = null;

      if (dto.format_id) {
        const f = (
          await this.pool.query('SELECT rules FROM match_formats WHERE id = $1', [dto.format_id])
        ).rows[0];
        if (!f) throw new BadRequestException('Unknown format_id');
        baseRules = f.rules;
      } else if (match.rules_snapshot) {
        baseRules = match.rules_snapshot;
      } else if (match.tournament_id) {
        const t = (
          await this.pool.query(
            `SELECT f.rules, t.rule_overrides FROM tournaments t
             JOIN match_formats f ON f.id = t.format_id WHERE t.id = $1`,
            [match.tournament_id],
          )
        ).rows[0];
        baseRules = t ? deepMerge(t.rules, t.rule_overrides) : {};
      } else {
        const fmt = (
          await this.pool.query(`SELECT rules FROM match_formats WHERE name = 'T20' LIMIT 1`)
        ).rows[0];
        baseRules = fmt?.rules ?? {};
      }

      const merged = dto.rule_overrides ? deepMerge(baseRules, dto.rule_overrides) : baseRules;
      updates.push(`rules_snapshot = $${paramIdx}`);
      values.push(JSON.stringify(merged));
      paramIdx += 1;
    }

    if (updates.length === 0) return { status: 'scheduled' };

    await this.pool.query(
      `UPDATE matches SET ${updates.join(', ')} WHERE id = $1`,
      values,
    );
    return { status: 'scheduled' };
  }

  /** Delete a match (only in scheduled state). */
  async deleteMatch(matchId: string) {
    const match = (await this.pool.query('SELECT id FROM matches WHERE id = $1', [matchId])).rows[0];
    if (!match) throw new NotFoundException('Match not found');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.purgeMatch(client, matchId);
      await client.query('COMMIT');
      return { deleted: true, match_id: matchId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a match and every row that hangs off it. Most FKs cascade from
   * matches, but two do NOT and would raise a foreign-key violation:
   *   - commentary_entries.ball_id → balls(id)  (blocks the innings→balls cascade)
   *   - matches.parent_match_id → matches(id)    (super-over child pins the parent)
   * So we delete the ball-scoped and innings-scoped children explicitly, in
   * dependency order, and recurse into any super-over child first.
   */
  private async purgeMatch(client: PoolClient, matchId: string) {
    // Super-over children point back at this match with no cascade — clear them
    // out first (each is a full match with its own innings/balls/commentary).
    const children = (
      await client.query('SELECT id FROM matches WHERE parent_match_id = $1', [matchId])
    ).rows;
    for (const child of children) await this.purgeMatch(client, child.id);

    const inn = { text: 'SELECT id FROM innings WHERE match_id = $1', values: [matchId] };

    // 1. Commentary — references balls via ball_id (no cascade), must go first.
    await client.query('DELETE FROM commentary_entries WHERE match_id = $1', [matchId]);
    // 2. Ball-stream + per-innings rollups.
    await client.query(`DELETE FROM balls WHERE innings_id IN (${inn.text})`, inn.values);
    await client.query(`DELETE FROM over_summaries WHERE innings_id IN (${inn.text})`, inn.values);
    await client.query(`DELETE FROM partnerships WHERE innings_id IN (${inn.text})`, inn.values);
    // 3. Squad (playing XI + bench) / officials.
    await client.query('DELETE FROM match_players WHERE match_id = $1', [matchId]);
    await client.query('DELETE FROM match_officials WHERE match_id = $1', [matchId]);
    await client.query('DELETE FROM match_interruptions WHERE match_id = $1', [matchId]);
    await client.query('DELETE FROM match_mvp_points WHERE match_id = $1', [matchId]);

    // player_career_stats is the one aggregate with no match_id, so it neither
    // cascades nor gets revisited by the finalize path once this match is gone.
    // Note who played here BEFORE their per-match rows disappear, then recompute
    // their careers from what survives — otherwise the runs scored in a deleted
    // match stay on the leaderboards permanently.
    const affected = (
      await client.query('SELECT DISTINCT player_id FROM player_match_stats WHERE match_id = $1', [matchId])
    ).rows.map((r) => r.player_id);
    await client.query('DELETE FROM player_match_stats WHERE match_id = $1', [matchId]);

    // 4. Innings, then the match itself.
    await client.query('DELETE FROM innings WHERE match_id = $1', [matchId]);
    await client.query('DELETE FROM matches WHERE id = $1', [matchId]);

    // Runs last: the career rebuild reads player_match_stats joined to matches,
    // so it must not see this match any more.
    await this.stats.rebuildCareerStatsForPlayers(client, affected);
  }

  /** Stats tab payload: wagon wheel vectors, partnerships, run-rate series. */
  async matchStats(matchId: string) {
    const wagon = (
      await this.pool.query(
        `SELECT b.striker_id AS batter_id, p.full_name AS batter, b.wagon, b.runs_batter,
                b.is_boundary_four, b.is_boundary_six, b.shot_type, i.seq AS innings
         FROM balls b
         JOIN innings i ON i.id = b.innings_id
         JOIN players p ON p.id = b.striker_id
         WHERE i.match_id = $1 AND NOT b.is_superseded AND b.wagon IS NOT NULL
         ORDER BY b.seq`,
        [matchId],
      )
    ).rows;

    // Partnerships: replay the ball stream per innings, splitting on wickets
    const innings = (
      await this.pool.query(
        `SELECT i.id, i.seq, tm.short_name AS batting_team FROM innings i
         JOIN teams tm ON tm.id = i.batting_team_id WHERE i.match_id = $1 ORDER BY i.seq`,
        [matchId],
      )
    ).rows;
    const partnerships: any[] = [];
    for (const inn of innings) {
      const balls = (
        await this.pool.query(
          `SELECT b.striker_id, b.non_striker_id, b.runs_batter, b.runs_extras, b.is_legal, b.is_wicket,
                  ps.full_name AS striker, pn.full_name AS non_striker
           FROM balls b
           JOIN players ps ON ps.id = b.striker_id
           JOIN players pn ON pn.id = b.non_striker_id
           WHERE b.innings_id = $1 AND NOT b.is_superseded ORDER BY b.seq`,
          [inn.id],
        )
      ).rows;
      let current: any = null;
      let wicketNo = 0;
      for (const b of balls) {
        const key = [b.striker_id, b.non_striker_id].sort().join('|');
        if (!current || current.key !== key) {
          if (current) partnerships.push(current);
          current = {
            key, innings: inn.seq, batting_team: inn.batting_team,
            batters: [b.striker, b.non_striker].sort(), runs: 0, balls: 0,
            wicket_number: wicketNo + 1, unbeaten: true,
          };
        }
        current.runs += b.runs_batter + b.runs_extras;
        if (b.is_legal) current.balls += 1;
        if (b.is_wicket) { wicketNo += 1; current.unbeaten = false; partnerships.push(current); current = null; }
      }
      if (current) partnerships.push(current);
    }
    partnerships.forEach((p) => delete p.key);

    const runRate = (
      await this.pool.query(
        `SELECT i.seq AS innings, tm.short_name AS batting_team, os.over_number, os.runs, os.wickets,
                os.cumulative_runs, os.cumulative_wickets
         FROM over_summaries os
         JOIN innings i ON i.id = os.innings_id
         JOIN teams tm ON tm.id = i.batting_team_id
         WHERE i.match_id = $1 ORDER BY i.seq, os.over_number`,
        [matchId],
      )
    ).rows;

    // Per-batter runs for the player-runs bar chart
    const batting = (
      await this.pool.query(
        `SELECT b.striker_id AS player_id, p.full_name, i.seq AS innings, tm.short_name AS team,
                coalesce(sum(b.runs_batter),0)::int AS runs,
                count(*) FILTER (WHERE b.extra_type IS DISTINCT FROM 'wide')::int AS balls
         FROM balls b
         JOIN innings i ON i.id = b.innings_id
         JOIN teams tm ON tm.id = i.batting_team_id
         JOIN players p ON p.id = b.striker_id
         WHERE i.match_id = $1 AND NOT b.is_superseded
         GROUP BY b.striker_id, p.full_name, i.seq, tm.short_name
         ORDER BY i.seq, min(b.seq)`,
        [matchId],
      )
    ).rows;

    return { wagon_wheel: wagon, partnerships, run_rate: runRate, batting };
  }

  /** Live state snapshot — Redis-first with Postgres fallback (response carries `source`). */
  state(id: string) {
    return this.live.getState(id);
  }

  /** Last N ball events from the Redis stream (instant UI hydration). */
  recentBalls(id: string, limit = 30) {
    return this.live.recentBalls(id, limit);
  }

  /** Live presence counts (viewers / scorers) from Redis sets. */
  presence(id: string) {
    return this.live.presence(id);
  }

  /** Replace one team's match squad (playing XI + 12th man with bat/bowl toggles). */
  async setSquad(matchId: string, teamId: string, players: any[]) {
    const match = (
      await this.pool.query(`SELECT team_a_id, team_b_id, status FROM matches WHERE id = $1`, [matchId])
    ).rows[0];
    if (!match) throw new NotFoundException('Match not found');
    if (![match.team_a_id, match.team_b_id].includes(teamId)) {
      throw new BadRequestException('Team is not part of this match');
    }
    if (['completed', 'abandoned', 'no_result', 'cancelled', 'forfeited'].includes(match.status)) {
      throw new BadRequestException('Squad cannot be changed after the match is finished');
    }
    const xi = players.filter((p) => p.is_playing_xi !== false && !p.is_twelfth);
    const keepers = xi.filter((p) => p.is_wicket_keeper);
    if (keepers.length > 1) throw new BadRequestException('Only one wicket-keeper in the XI');

    // Mid-match squad edits are allowed (substitutions, fixing a mistake), but
    // a player from this team who has already batted, bowled, or been dismissed
    // is woven into the live state and scorecard — dropping them would orphan
    // that data, so they must stay in the XI.
    if (!['scheduled', 'toss'].includes(match.status)) {
      const participated = (
        await this.pool.query(
          `SELECT DISTINCT x.pid
             FROM (
               SELECT striker_id AS pid FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = $1
               UNION SELECT non_striker_id FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = $1
               UNION SELECT bowler_id FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = $1
               UNION SELECT dismissed_player_id FROM balls b JOIN innings i ON i.id = b.innings_id
                 WHERE i.match_id = $1 AND dismissed_player_id IS NOT NULL
             ) x
             JOIN match_players mp ON mp.player_id = x.pid AND mp.match_id = $1 AND mp.team_id = $2`,
          [matchId, teamId],
        )
      ).rows.map((r) => r.pid);
      const newXi = new Set(xi.map((p) => p.player_id));
      const dropped = participated.filter((id) => !newXi.has(id));
      if (dropped.length > 0) {
        throw new BadRequestException(
          'Cannot remove a player who has already batted or bowled in this match',
        );
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM match_players WHERE match_id = $1 AND team_id = $2`, [matchId, teamId]);
      for (const [i, p] of players.entries()) {
        await client.query(
          `INSERT INTO match_players (match_id, team_id, player_id, is_playing_xi, is_twelfth,
                                      can_bat, can_bowl, is_captain, is_wicket_keeper, batting_order)
           VALUES ($1,$2,$3, coalesce($4,true), coalesce($5,false), coalesce($6,true), coalesce($7,true),
                   coalesce($8,false), coalesce($9,false), coalesce($10::smallint, $11::smallint))`,
          [matchId, teamId, p.player_id, p.is_playing_xi, p.is_twelfth, p.can_bat, p.can_bowl,
           p.is_captain, p.is_wicket_keeper, p.batting_order ?? null, i + 1],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return this.squads(matchId);
  }

  async squads(matchId: string) {
    const registered = (
      await this.pool.query(
        `SELECT mp.team_id, tm.short_name AS team, mp.player_id, p.full_name, p.primary_role,
                mp.is_playing_xi, mp.is_twelfth, mp.can_bat, mp.can_bowl,
                mp.is_captain, mp.is_wicket_keeper, mp.batting_order
         FROM match_players mp
         JOIN players p ON p.id = mp.player_id
         JOIN teams tm ON tm.id = mp.team_id
         WHERE mp.match_id = $1
         ORDER BY mp.team_id, mp.batting_order NULLS LAST`,
        [matchId],
      )
    ).rows;
    if (registered.length > 0) return registered;

    // Casual scoring: no squad was registered, so derive who actually played
    // from the ball stream (batters + bowlers + fielders), in appearance order.
    return (
      await this.pool.query(
        `WITH appearances AS (
           SELECT b.striker_id AS player_id, i.batting_team_id AS team_id, b.seq
             FROM balls b JOIN innings i ON i.id = b.innings_id
            WHERE i.match_id = $1 AND NOT b.is_superseded
           UNION ALL
           SELECT b.non_striker_id, i.batting_team_id, b.seq
             FROM balls b JOIN innings i ON i.id = b.innings_id
            WHERE i.match_id = $1 AND NOT b.is_superseded
           UNION ALL
           SELECT b.bowler_id, i.bowling_team_id, b.seq
             FROM balls b JOIN innings i ON i.id = b.innings_id
            WHERE i.match_id = $1 AND NOT b.is_superseded
           UNION ALL
           SELECT b.fielder_id, i.bowling_team_id, b.seq
             FROM balls b JOIN innings i ON i.id = b.innings_id
            WHERE i.match_id = $1 AND NOT b.is_superseded AND b.fielder_id IS NOT NULL
         ),
         participants AS (
           SELECT player_id, team_id, min(seq) AS first_seq
           FROM appearances GROUP BY player_id, team_id
         )
         SELECT pt.team_id, tm.short_name AS team, pt.player_id, p.full_name, p.primary_role,
                true AS is_playing_xi, false AS is_twelfth, true AS can_bat, true AS can_bowl,
                false AS is_captain, false AS is_wicket_keeper, NULL::smallint AS batting_order
         FROM participants pt
         JOIN players p ON p.id = pt.player_id
         JOIN teams tm ON tm.id = pt.team_id
         ORDER BY pt.team_id, pt.first_seq`,
        [matchId],
      )
    ).rows;
  }

  /** Full scorecard: batting + bowling cards per innings, fall of wickets. */
  async scorecard(matchId: string) {
    const innings = (
      await this.pool.query(
        `SELECT i.*, bt.name AS batting_team, bt.short_name AS batting_short,
                bw.name AS bowling_team, bw.short_name AS bowling_short
         FROM innings i
         JOIN teams bt ON bt.id = i.batting_team_id
         JOIN teams bw ON bw.id = i.bowling_team_id
         WHERE i.match_id = $1 ORDER BY i.seq`,
        [matchId],
      )
    ).rows;
    // A team's per-match player_match_stats row aggregates across every
    // innings that team batted/bowled in. That's only safe to reuse as a
    // per-innings fallback when the team appears in exactly one innings
    // (true for every limited-overs format; not true for Tests/follow-ons).
    const inningsPerTeam = new Map<string, number>();
    for (const i of innings) inningsPerTeam.set(i.batting_team_id, (inningsPerTeam.get(i.batting_team_id) ?? 0) + 1);

    for (const inn of innings) {
      inn.batting = (
        await this.pool.query(
          `SELECT id, full_name, balls, runs, fours, sixes, is_out, dismissal
           FROM (
             -- Batters who faced at least one delivery as striker
             SELECT p.id, p.full_name,
                    min(b.seq) AS first_seq, 0 AS tie_break,
                    count(*) FILTER (WHERE b.is_legal OR b.extra_type = 'no_ball')::int AS balls,
                    coalesce(sum(b.runs_batter),0)::int AS runs,
                    count(*) FILTER (WHERE b.is_boundary_four)::int AS fours,
                    count(*) FILTER (WHERE b.is_boundary_six)::int AS sixes,
                    false AS is_out, null::text AS dismissal
             FROM balls b JOIN players p ON p.id = b.striker_id
             WHERE b.innings_id = $1 AND NOT b.is_superseded
             GROUP BY p.id, p.full_name
             UNION ALL
             -- Non-striker batters dismissed before facing any delivery as striker
             SELECT p.id, p.full_name,
                    min(b.seq) AS first_seq, 1 AS tie_break,
                    0::int AS balls, 0::int AS runs,
                    0::int AS fours, 0::int AS sixes,
                    false AS is_out, null::text AS dismissal
             FROM balls b JOIN players p ON p.id = b.dismissed_player_id
             WHERE b.innings_id = $1 AND b.is_wicket AND NOT b.is_superseded
               AND b.dismissed_player_id IS NOT NULL
               AND b.dismissed_player_id NOT IN (
                 SELECT striker_id FROM balls WHERE innings_id = $1 AND NOT is_superseded
               )
             GROUP BY p.id, p.full_name
           ) batters
           ORDER BY first_seq, tie_break`,
          [inn.id],
        )
      ).rows;
      // Dismissals joined separately (not via striker) so a non-striker run out is credited too.
      const wickets = (
        await this.pool.query<WicketRow>(
          `SELECT b.dismissed_player_id, b.wicket_type::text AS wicket_type, b.bowler_id, b.fielder_id,
                  bp.full_name AS bowler_name, fp.full_name AS fielder_name
           FROM balls b
           JOIN players bp ON bp.id = b.bowler_id
           LEFT JOIN players fp ON fp.id = b.fielder_id
           WHERE b.innings_id = $1 AND b.is_wicket AND NOT b.is_superseded
             AND b.dismissed_player_id IS NOT NULL`,
          [inn.id],
        )
      ).rows;
      const wicketByBatter = new Map<string, WicketRow>(wickets.map((w) => [w.dismissed_player_id, w]));
      for (const bat of inn.batting) {
        const w = wicketByBatter.get(bat.id);
        if (w) {
          bat.is_out = true;
          bat.dismissal = dismissalText(w);
        }
      }
      inn.bowling = (
        await this.pool.query(
          `SELECT p.id, p.full_name,
                  count(*) FILTER (WHERE b.is_legal)::int AS legal_balls,
                  coalesce(sum(b.runs_batter + CASE WHEN b.extra_type IN ('wide','no_ball') THEN b.runs_extras - b.secondary_extra_runs ELSE 0 END),0)::int AS runs_conceded,
                  count(*) FILTER (WHERE b.is_wicket AND b.wicket_type NOT IN ('run_out','retired_hurt','retired_out','obstructing_field','timed_out'))::int AS wickets,
                  coalesce((SELECT count(*) FROM over_summaries os WHERE os.innings_id = $1 AND os.bowler_id = p.id AND os.is_maiden), 0)::int AS maidens
           FROM balls b JOIN players p ON p.id = b.bowler_id
           WHERE b.innings_id = $1 AND NOT b.is_superseded
           GROUP BY p.id, p.full_name
           ORDER BY min(b.seq)`,
          [inn.id],
        )
      ).rows;
      inn.fall_of_wickets = (
        await this.pool.query(
          `SELECT b.over_number, b.ball_in_over, p.full_name AS batter, b.wicket_type,
                  (SELECT count(*)::int FROM balls b3
                   WHERE b3.innings_id = b.innings_id AND b3.seq <= b.seq AND b3.is_wicket AND NOT b3.is_superseded) AS wicket_number,
                  (SELECT coalesce(sum(b2.runs_batter + b2.runs_extras),0)::int FROM balls b2
                   WHERE b2.innings_id = b.innings_id AND b2.seq <= b.seq AND NOT b2.is_superseded) AS score_at
           FROM balls b
           JOIN players p ON p.id = b.dismissed_player_id
           WHERE b.innings_id = $1 AND b.is_wicket AND NOT b.is_superseded
           ORDER BY b.seq`,
          [inn.id],
        )
      ).rows;

      // Fallback: the innings clearly happened (non-zero totals recorded by
      // the scoring engine) but no ball rows survive to derive batting/bowling
      // from — e.g. historical data where the balls were lost some other way.
      // Reconstruct a best-effort card from the player_match_stats snapshot
      // taken at match finalize, which is per-match rather than per-innings,
      // so this is only trustworthy when the team batted in exactly one
      // innings all match (every limited-overs format; not Tests/follow-ons).
      inn.detail_source = 'balls';
      const inningsHappened = inn.total_runs > 0 || inn.total_wickets > 0 || inn.legal_balls > 0;
      if (inn.batting.length === 0 && inningsHappened && inningsPerTeam.get(inn.batting_team_id) === 1) {
        inn.detail_source = 'summary';
        inn.batting = (
          await this.pool.query(
            `SELECT p.id, p.full_name, pms.balls_faced AS balls, pms.runs_scored AS runs,
                    pms.fours, pms.sixes, pms.is_out, pms.dismissal_type::text AS dismissal
             FROM player_match_stats pms JOIN players p ON p.id = pms.player_id
             WHERE pms.match_id = $1 AND pms.team_id = $2 AND pms.batted
             ORDER BY pms.runs_scored DESC`,
            [matchId, inn.batting_team_id],
          )
        ).rows;
        inn.bowling = (
          await this.pool.query(
            `SELECT p.id, p.full_name, pms.balls_bowled AS legal_balls, pms.maidens,
                    pms.runs_conceded, pms.wickets_taken AS wickets
             FROM player_match_stats pms JOIN players p ON p.id = pms.player_id
             WHERE pms.match_id = $1 AND pms.team_id = $2 AND pms.bowled
             ORDER BY pms.wickets_taken DESC, pms.runs_conceded ASC`,
            [matchId, inn.bowling_team_id],
          )
        ).rows;
        inn.fall_of_wickets = []; // not reconstructable from match-level aggregates
      }
    }
    return innings;
  }

  /** Over-by-over data for Manhattan / over comparison. */
  async overs(matchId: string) {
    return (
      await this.pool.query(
        `SELECT i.seq AS innings, tm.short_name AS batting_team, os.over_number, os.runs, os.wickets,
                os.extras, os.is_maiden, os.cumulative_runs, os.cumulative_wickets, p.full_name AS bowler
         FROM over_summaries os
         JOIN innings i ON i.id = os.innings_id
         JOIN teams tm ON tm.id = i.batting_team_id
         JOIN players p ON p.id = os.bowler_id
         WHERE i.match_id = $1
         ORDER BY i.seq, os.over_number`,
        [matchId],
      )
    ).rows;
  }

  async commentary(matchId: string, limit = 50, before?: string, inningsSeq?: number) {
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      throw new BadRequestException('before must be an ISO timestamp');
    }
    return (
      await this.pool.query(
        `SELECT c.id, c.body, c.source, c.is_highlight, c.created_at, u.full_name AS author,
                c.ball_id, b.over_number, b.ball_in_over,
                b.runs_batter, b.runs_extras, b.extra_type, b.secondary_extra_type,
                b.secondary_extra_runs, b.is_boundary_four, b.is_boundary_six,
                b.is_wicket, b.wicket_type,
                b.striker_id, sp.full_name AS striker_name,
                b.non_striker_id, np.full_name AS non_striker_name,
                b.bowler_id, bp.full_name AS bowler_name,
                b.dismissed_player_id, dp.full_name AS dismissed_player_name,
                c.fielder_player_id, fp.full_name AS fielder_name
         FROM commentary_entries c
         LEFT JOIN users u ON u.id = c.author_id
         LEFT JOIN balls b ON b.id = c.ball_id
         LEFT JOIN players sp ON sp.id = b.striker_id
         LEFT JOIN players np ON np.id = b.non_striker_id
         LEFT JOIN players bp ON bp.id = b.bowler_id
         LEFT JOIN players dp ON dp.id = b.dismissed_player_id
         LEFT JOIN players fp ON fp.id = c.fielder_player_id
         WHERE c.match_id = $1 AND ($3::timestamptz IS NULL OR c.created_at < $3)
           AND ($4::int IS NULL OR c.innings_id = (SELECT id FROM innings WHERE match_id = $1 AND seq = $4))
         ORDER BY c.created_at DESC LIMIT $2`,
        [matchId, Math.min(limit, 200), before ?? null, inningsSeq ?? null],
      )
    ).rows;
  }

  async addCommentary(matchId: string, userId: string, dto: { body: string; is_highlight?: boolean; ball_id?: string; fielder_player_id?: string }) {
    // Fielding events (dropped catch / run out missed / misfield) describe the
    // delivery just bowled, so tag them with the last ball of the live innings
    // when the client didn't pin one. This makes them "belong" to that ball: an
    // undo of the ball removes the fielding note too (see ScoringService.undoLast),
    // instead of leaving it orphaned in the feed. Detected by the same body
    // prefixes the stats aggregates use. Free-text colour commentary is left
    // ball-less so it survives an undo.
    const FIELDING_PREFIXES = ['DROPPED CATCH!', 'RUN OUT MISSED!', 'MISFIELD!'];
    let ballId = dto.ball_id ?? null;
    if (!ballId && FIELDING_PREFIXES.some((p) => dto.body.startsWith(p))) {
      ballId = (
        await this.pool.query(
          `SELECT b.id FROM balls b JOIN innings i ON i.id = b.innings_id
           WHERE i.match_id = $1 AND i.status = 'in_progress' AND NOT b.is_superseded
           ORDER BY b.seq DESC LIMIT 1`,
          [matchId],
        )
      ).rows[0]?.id ?? null;
    }
    const res = await this.pool.query(
      `INSERT INTO commentary_entries (match_id, author_id, source, body, is_highlight, ball_id,
                                       innings_id, fielder_player_id)
       VALUES ($1, $2, 'manual', $3, coalesce($4,false), $5,
               coalesce(
                 (SELECT innings_id FROM balls WHERE id = $5),
                 (SELECT id FROM innings WHERE match_id = $1 AND status = 'in_progress' LIMIT 1)
               ),
               $6)
       RETURNING *`,
      [matchId, userId, dto.body, dto.is_highlight, ballId, dto.fielder_player_id ?? null],
    );
    return res.rows[0];
  }

  async mvp(matchId: string) {
    return (
      await this.pool.query(
        // Streams keep their real sign; only the headline total floors at 0.
        // Ordering stays on the true value so the table doesn't collapse into
        // an arbitrary run of zeroes at the bottom.
        `SELECT mmp.match_id, mmp.player_id,
                mmp.batting_points, mmp.bowling_points, mmp.fielding_points,
                greatest(mmp.total_points, 0) AS total_points,
                (m.player_of_match_id = mmp.player_id) AS is_player_of_match,
                p.full_name, tm.short_name AS team
         FROM match_mvp_points mmp
         JOIN matches m ON m.id = mmp.match_id
         JOIN players p ON p.id = mmp.player_id
         JOIN player_match_stats pms ON pms.match_id = mmp.match_id AND pms.player_id = mmp.player_id
         JOIN teams tm ON tm.id = pms.team_id
         WHERE mmp.match_id = $1 ORDER BY mmp.total_points DESC`,
        [matchId],
      )
    ).rows;
  }

  /** Grant match-scoped scorer access to a user. */
  async assignScorer(matchId: string, dto: { user_id: string; expires_at?: string }, grantedBy: string) {
    await this.pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, match_id, granted_by, expires_at)
       SELECT $1, id, $2, $3, $4 FROM roles WHERE slug = 'scorer' AND organization_id IS NULL
       ON CONFLICT DO NOTHING`,
      [dto.user_id, matchId, grantedBy, dto.expires_at ?? null],
    );
    return { assigned: true };
  }
}
