import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { SaasService } from '../saas/saas.service';
import { LiveStateService } from './live-state.service';
import { FormatRules, LiveInningsState } from './rules-engine';

/**
 * Rotation ("gully") mode: one batter at a time, no real teams, everyone in the
 * pool bats once and shares the bowling.
 *
 * This service owns SETUP and LIFECYCLE — roster, start, bowler changes,
 * retirement, withdrawal, resizing. The ball hot path stays in
 * ScoringService: rotation is a rules_snapshot profile over the same engine, so
 * POST /matches/:id/balls is unchanged and every derived artefact (scorecard,
 * over summaries, replay, undo, MVP) keeps working untouched.
 *
 * The dependency runs one way — ScoringService imports helpers from here, never
 * the reverse — so there is no module cycle.
 */

/** Slug/short-name of the two synthetic pool teams every rotation match reuses. */
const POOL_TEAM = { slug: 'gully-pool', name: 'Gully Pool', short: 'POOL' };
const FIELD_TEAM = { slug: 'gully-field', name: 'Gully Field', short: 'FIELD' };

export interface RotationSlot {
  player_id: string;
  name: string;
  bat_order: number;
  balls_allotted: number;
  balls_faced: number;
  runs_scored: number;
  ended_reason: string | null;
}

@Injectable()
export class RotationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly live: LiveStateService,
    private readonly saas: SaasService,
  ) {}

  // ------------------------------------------------------------ transaction
  /** Same contract as ScoringService.withMatch: row-locked, single writer. */
  private async withMatch<T>(matchId: string, fn: (client: PoolClient, match: any) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(`SELECT * FROM matches WHERE id = $1 FOR UPDATE`, [matchId]);
      if (res.rowCount === 0) throw new NotFoundException('Match not found');
      const out = await fn(client, res.rows[0]);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private assertRotation(match: any): void {
    if (match.mode !== 'rotation') {
      throw new BadRequestException('This is not a rotation (gully) match');
    }
  }

  // ------------------------------------------------------- synthetic teams
  /**
   * matches.team_a_id/team_b_id are NOT NULL with CHECK (team_a_id <> team_b_id),
   * and three other tables carry a NOT NULL team_id. Rather than relax all of
   * them, each org gets two hidden team rows that every rotation match reuses.
   * They are flagged is_synthetic so team listings, standings and head-to-head
   * can exclude them.
   */
  private async ensurePoolTeams(client: PoolClient, orgId: string): Promise<{ poolId: string; fieldId: string }> {
    const ids: string[] = [];
    for (const t of [POOL_TEAM, FIELD_TEAM]) {
      const found = await client.query(
        `SELECT id FROM teams WHERE organization_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [orgId, t.slug],
      );
      if (found.rowCount! > 0) { ids.push(found.rows[0].id); continue; }
      const created = await client.query(
        `INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [orgId, t.name, t.short, t.slug],
      );
      ids.push(created.rows[0].id);
    }
    return { poolId: ids[0], fieldId: ids[1] };
  }

  // ------------------------------------------------------------------ rules
  /**
   * Build the frozen rules document for a roster of N players at M overs each.
   *
   * players_per_side is deliberately batter_count + 1. The engine's
   * last-man-standing branch fires at players_per_side - 1 wickets; with
   * players_per_side === batter_count it would seize both ends on the
   * second-to-last batter and the final batter would never get to bat.
   */
  static buildRules(batterCount: number, oversPerBatter: number, ballsPerOver: number, house: Record<string, any> = {}): FormatRules {
    const totalOvers = batterCount * oversPerBatter;
    return {
      innings_per_side: 1,
      overs_per_innings: totalOvers,
      balls_per_over: ballsPerOver,
      players_per_side: batterCount + 1,
      wickets_to_fall: batterCount,
      // Everyone bowls an equal share; ceil so the overs are always reachable
      // even when the pool does not divide evenly.
      max_overs_per_bowler: Math.ceil(totalOvers / Math.max(1, batterCount)),
      powerplays: [],
      super_over: { enabled: false },
      dls: { enabled: false },
      follow_on: { enabled: false },
      declaration_allowed: false,
      no_ball: { runs: 1, free_hit: false },
      wide: { runs: 1 },
      twelfth_man: { allowed: false },
      solo_batting: {
        enabled: true,
        batter_count: batterCount,
        balls_per_batter: oversPerBatter * ballsPerOver,
        retire_on_quota: true,
        bowler_may_be_batter: false,
      },
      gully: {
        one_tip_one_hand: house.one_tip_one_hand ?? true,
        lbw_enabled: house.lbw_enabled ?? false,
        last_batter_doubles: house.last_batter_doubles ?? false,
        boundary_out: house.boundary_out ?? false,
      },
      mvp_profile: 'gully_v1',
    } as unknown as FormatRules;
  }

  // ----------------------------------------------------------------- create
  /**
   * Create a standalone rotation match. Deliberately NOT MatchesService.createManual:
   * that requires a tournament and asserts both teams are attached to it, neither
   * of which means anything for a pickup game in a car park.
   */
  async createMatch(orgId: string, dto: { scheduled_start?: string; venue_id?: string; match_number?: number }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { poolId, fieldId } = await this.ensurePoolTeams(client, orgId);
      const res = await client.query(
        `INSERT INTO matches (tournament_id, organization_id, mode, match_number, stage,
                              team_a_id, team_b_id, venue_id, scheduled_start)
         VALUES (NULL, $1, 'rotation', $2, 'custom', $3, $4, $5, coalesce($6::timestamptz, now()))
         RETURNING *`,
        [orgId, dto.match_number ?? null, poolId, fieldId, dto.venue_id ?? null, dto.scheduled_start ?? null],
      );
      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ----------------------------------------------------------------- roster
  /**
   * The entire pre-match setup in one idempotent call: who is playing, how many
   * overs each, and in what order. Rejected once the match is live — batter_count
   * is baked into the frozen rules_snapshot, and changing it mid-match has to go
   * through resizeRotation() so all five copies of the innings length move together.
   */
  async setRoster(matchId: string, dto: {
    player_ids: string[];
    active_count?: number;
    overs_per_batter: number;
    balls_per_over?: number;
    shuffle_order?: boolean;
    house_rules?: Record<string, any>;
  }) {
    return this.withMatch(matchId, async (client, match) => {
      this.assertRotation(match);
      if (match.status !== 'scheduled') {
        throw new BadRequestException(
          `Roster is locked once the match starts (status: ${match.status}). ` +
          'Use the withdraw or settings endpoints to change a live match.',
        );
      }

      const unique = [...new Set(dto.player_ids)];
      if (unique.length !== dto.player_ids.length) {
        throw new BadRequestException('The same player appears twice in the roster');
      }
      const activeCount = dto.active_count ?? unique.length;
      if (activeCount < 2) throw new BadRequestException('A rotation match needs at least 2 players');
      if (activeCount > unique.length) {
        throw new BadRequestException(`active_count (${activeCount}) exceeds the ${unique.length} players supplied`);
      }
      if (dto.overs_per_batter < 1) throw new BadRequestException('overs_per_batter must be at least 1');

      // Players must belong to this org — a roster is not a route to another
      // org's player rows.
      const owned = await client.query(
        `SELECT id, full_name FROM players WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND deleted_at IS NULL`,
        [unique, match.organization_id],
      );
      if (owned.rowCount !== unique.length) {
        throw new BadRequestException('One or more players do not exist in this organization');
      }
      const nameOf = new Map<string, string>(owned.rows.map((r: any) => [r.id, r.full_name]));

      const active = unique.slice(0, activeCount);
      const order = dto.shuffle_order ? shuffled(active) : active;
      const ballsPerOver = dto.balls_per_over ?? 6;
      const rules = RotationService.buildRules(order.length, dto.overs_per_batter, ballsPerOver, dto.house_rules ?? {});
      const ballsPerBatter = dto.overs_per_batter * ballsPerOver;

      // Rebuild from scratch so the call is idempotent.
      await client.query(`DELETE FROM rotation_slots WHERE match_id = $1`, [matchId]);
      await client.query(`DELETE FROM rotation_bowl_quota WHERE match_id = $1`, [matchId]);
      await client.query(`DELETE FROM match_players WHERE match_id = $1`, [matchId]);

      for (const [i, playerId] of order.entries()) {
        await client.query(
          `INSERT INTO match_players (match_id, team_id, player_id, is_playing_xi, can_bat, can_bowl, batting_order)
           VALUES ($1, $2, $3, true, true, true, $4)`,
          [matchId, match.team_a_id, playerId, i + 1],
        );
        await client.query(
          `INSERT INTO rotation_slots (match_id, player_id, bat_order, balls_allotted)
           VALUES ($1, $2, $3, $4)`,
          [matchId, playerId, i + 1, ballsPerBatter],
        );
        await client.query(
          `INSERT INTO rotation_bowl_quota (match_id, player_id, overs_allotted)
           VALUES ($1, $2, $3)`,
          [matchId, playerId, rules.max_overs_per_bowler],
        );
      }

      await client.query(
        `UPDATE matches SET rules_snapshot = $2 WHERE id = $1`,
        [matchId, JSON.stringify(rules)],
      );

      const warnings: string[] = [];
      const totalOvers = order.length * dto.overs_per_batter;
      if (rules.max_overs_per_bowler! * order.length === totalOvers) {
        warnings.push(
          `${totalOvers} overs across ${order.length} bowlers leaves no slack — ` +
          'if anyone leaves early you will have to raise the per-bowler cap.',
        );
      }
      if (order.length < 4) {
        warnings.push('With fewer than 4 players the no-consecutive-overs rule leaves very few legal bowling choices.');
      }

      return {
        mode: 'rotation',
        batter_count: order.length,
        overs_per_batter: dto.overs_per_batter,
        total_overs: totalOvers,
        max_overs_per_bowler: rules.max_overs_per_bowler,
        slots: order.map((id, i) => ({
          bat_order: i + 1,
          player_id: id,
          name: nameOf.get(id) ?? 'Unknown',
          balls_allotted: ballsPerBatter,
          ended_reason: null,
        })),
        warnings,
      };
    });
  }

  // ------------------------------------------------------------------ start
  /**
   * Replaces toss + openers. There is no toss (no teams to win it) and no
   * non-striker, so the whole pre-innings dance collapses to "who bats, who
   * bowls".
   */
  async start(matchId: string, dto: { striker_id?: string; bowler_id: string }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      this.assertRotation(match);
      if (match.status !== 'scheduled') {
        throw new BadRequestException(`Match already started (status: ${match.status})`);
      }
      await this.saas.assertQuota(match.organization_id, 'max_concurrent_matches');

      const rules: FormatRules = match.rules_snapshot;
      if (!rules?.solo_batting?.enabled) {
        throw new BadRequestException('Set the roster before starting — no rotation rules are frozen on this match');
      }

      const slots = await this.loadSlots(client, matchId);
      if (slots.length === 0) throw new BadRequestException('No rotation slots — set the roster first');

      // Default the opening batter to bat_order 1 so the common case is one tap.
      const striker = dto.striker_id ?? slots[0].player_id;
      if (!slots.some((s) => s.player_id === striker)) {
        throw new BadRequestException('The opening batter is not in this match roster');
      }
      if (!slots.some((s) => s.player_id === dto.bowler_id)) {
        throw new BadRequestException('The opening bowler is not in this match roster');
      }
      if (dto.bowler_id === striker) {
        throw new BadRequestException('The batter cannot bowl to themselves — pick another bowler');
      }

      const innings = (
        await client.query(
          `INSERT INTO innings (match_id, seq, batting_team_id, bowling_team_id, status, max_overs, started_at)
           VALUES ($1, 1, $2, $3, 'in_progress', $4, now()) RETURNING id`,
          [matchId, match.team_a_id, match.team_b_id, rules.overs_per_innings],
        )
      ).rows[0];

      await client.query(
        `UPDATE rotation_slots SET innings_id = $2 WHERE match_id = $1`,
        [matchId, innings.id],
      );
      await client.query(
        `UPDATE rotation_slots SET started_at = now() WHERE match_id = $1 AND player_id = $2`,
        [matchId, striker],
      );

      // The solo batter occupies BOTH ends. That is the shape the engine
      // already takes under last man standing, which is why strike rotation and
      // the over-change swap need no special-casing — they become swaps of a
      // value with itself.
      const engine: LiveInningsState = {
        seq: Number(match.live_state_seq),
        totalRuns: 0, totalWickets: 0, legalBalls: 0,
        maxOvers: rules.overs_per_innings,
        target: null,
        freeHitPending: false, currentOverBalls: 0, lastOverBowlerId: null,
        bowlerLegalBalls: {},
        strikerId: striker, nonStrikerId: striker,
        battersRetiredHurt: [],
        batterLegalBalls: {}, battersCompleted: [],
      };

      const ls: any = {
        innings_id: innings.id,
        innings_seq: 1,
        engine,
        batters: { [striker]: await this.card(client, striker) },
        bowlers: { [dto.bowler_id]: await this.bowlerCard(client, dto.bowler_id) },
        this_over: [],
        over_bowler_runs: 0,
        pending_new_batter: null,
        current_bowler: dto.bowler_id,
        summary: {
          batting_team: 'POOL', score: '0/0', overs: '0.0',
          target: null, current_rr: 0, required_rr: null,
        },
      };
      ls.rotation = await this.buildBlock(client, matchId, rules, engine);

      await client.query(
        `UPDATE matches SET status = 'live', live_state = $2, actual_start = now() WHERE id = $1`,
        [matchId, JSON.stringify(ls)],
      );
      return { status: 'live', innings_id: innings.id, state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'rotation_start' });
    return out;
  }

  // ----------------------------------------------------------------- bowler
  /**
   * Set the bowler for the coming over. Validating here rather than on the
   * first ball means the scorer is told at selection time, while they are still
   * looking at the bowler list, instead of having a delivery rejected.
   */
  async setBowler(matchId: string, dto: { bowler_id: string }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      this.assertRotation(match);
      if (match.status !== 'live') throw new BadRequestException(`Match is not live (status: ${match.status})`);
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;
      const eng: LiveInningsState = ls?.engine;
      if (!eng) throw new BadRequestException('Match has not started');

      const problem = RotationService.bowlerProblem(dto.bowler_id, eng, rules);
      if (problem) throw new ConflictException(problem);

      const inRoster = await client.query(
        `SELECT 1 FROM rotation_slots WHERE match_id = $1 AND player_id = $2`, [matchId, dto.bowler_id]);
      if (inRoster.rowCount === 0) throw new BadRequestException('That player is not in this match roster');

      ls.current_bowler = dto.bowler_id;
      ls.bowlers[dto.bowler_id] ??= await this.bowlerCard(client, dto.bowler_id);
      ls.rotation = await this.buildBlock(client, matchId, rules, eng);
      await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      return { current_bowler: dto.bowler_id, state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'bowler_change' });
    return out;
  }

  /**
   * Why this bowler cannot bowl the next over, or null when they can. Shared
   * with the suggestion ranking so the two can never disagree.
   */
  static bowlerProblem(bowlerId: string, eng: LiveInningsState, rules: FormatRules): { code: string; message: string } | null {
    if (rules.solo_batting?.enabled && !rules.solo_batting.bowler_may_be_batter && bowlerId === eng.strikerId) {
      return { code: 'BOWLER_IS_BATTER', message: 'The batter cannot bowl to themselves — pick another bowler' };
    }
    if (bowlerId === eng.lastOverBowlerId) {
      return { code: 'CONSECUTIVE_OVERS', message: 'That bowler bowled the previous over' };
    }
    if (rules.max_overs_per_bowler !== null && rules.max_overs_per_bowler !== undefined) {
      const bowled = eng.bowlerLegalBalls?.[bowlerId] ?? 0;
      if (bowled >= rules.max_overs_per_bowler * rules.balls_per_over) {
        return { code: 'BOWLER_QUOTA', message: `That bowler has completed their ${rules.max_overs_per_bowler} overs` };
      }
    }
    return null;
  }

  /**
   * Ranked "who bowls next" suggestions: fewest balls bowled first, then whoever
   * has gone longest since their last over. Advisory only — the scorer can pick
   * anyone legal, because in a real gully match somebody's brother turns up and
   * has to be given a bowl.
   */
  async nextBowler(matchId: string) {
    const match = (await this.pool.query(`SELECT * FROM matches WHERE id = $1`, [matchId])).rows[0];
    if (!match) throw new NotFoundException('Match not found');
    this.assertRotation(match);
    const rules: FormatRules = match.rules_snapshot;
    const eng: LiveInningsState | undefined = match.live_state?.engine;
    if (!eng) return { suggestions: [], ineligible: [] };

    const rows = (await this.pool.query(
      `SELECT q.player_id, q.legal_balls, q.last_over_number, p.full_name
         FROM rotation_bowl_quota q JOIN players p ON p.id = q.player_id
        WHERE q.match_id = $1`,
      [matchId],
    )).rows;

    const suggestions: any[] = [];
    const ineligible: any[] = [];
    for (const r of rows) {
      const problem = RotationService.bowlerProblem(r.player_id, eng, rules);
      const entry = {
        player_id: r.player_id,
        name: r.full_name,
        overs_bowled: Math.floor(r.legal_balls / (rules.balls_per_over ?? 6)),
        legal_balls: r.legal_balls,
        last_over_number: r.last_over_number,
      };
      if (problem) ineligible.push({ ...entry, reason: problem.message, code: problem.code });
      else suggestions.push({ ...entry, reason: r.legal_balls === 0 ? 'yet to bowl' : `${entry.overs_bowled} of ${rules.max_overs_per_bowler} used` });
    }
    suggestions.sort((a, b) =>
      a.legal_balls - b.legal_balls
      || (a.last_over_number ?? -1) - (b.last_over_number ?? -1)
      || a.name.localeCompare(b.name));
    return { suggestions, ineligible };
  }

  // --------------------------------------------------------------- retire
  /**
   * A batter chooses to stop (or has to leave). Recorded on the SLOT rather than
   * as a delivery: a retirement is not a ball, and writing one into the
   * append-only ball stream would consume a legal delivery that was never bowled.
   *
   * replayInnings() seeds battersCompleted from these rows precisely because
   * they are not derivable from the ball stream.
   */
  async retire(matchId: string, dto: { player_id?: string; reason?: 'voluntary' | 'withdrawn' }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      this.assertRotation(match);
      if (match.status !== 'live') throw new BadRequestException(`Match is not live (status: ${match.status})`);
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;
      const eng: LiveInningsState = ls?.engine;
      if (!eng) throw new BadRequestException('Match has not started');

      const playerId = dto.player_id ?? eng.strikerId;
      if (playerId !== eng.strikerId) {
        throw new BadRequestException('Only the batter currently at the crease can retire');
      }
      if (eng.battersCompleted?.includes(playerId)) {
        throw new BadRequestException('That batter has already finished their innings');
      }

      eng.battersCompleted = [...(eng.battersCompleted ?? []), playerId];
      await this.closeSlot(client, matchId, playerId, dto.reason ?? 'voluntary');
      if (ls.batters?.[playerId]) ls.batters[playerId].out = true;

      const done = eng.battersCompleted.length >= (rules.solo_batting?.batter_count ?? 0);
      ls.pending_new_batter = done ? null : playerId;
      ls.rotation = await this.buildBlock(client, matchId, rules, eng);

      await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      return { retired: playerId, innings_complete: done, state: ls, _done: done };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'batter_retired' });
    if (out._done) {
      // The pool is out of batters. Closing the innings is ScoringService's job
      // (it owns the innings/match ordering), so surface it rather than racing it.
      return { ...out, note: 'All batters are done — close the innings to finalise the match.' };
    }
    const { _done, ...pub } = out;
    return pub;
  }

  // -------------------------------------------------------------- withdraw
  /**
   * A player leaves mid-match. Three different situations, one endpoint:
   *  - not yet batted  -> their slot disappears and the innings gets shorter
   *  - already batted  -> batting is untouched; only their unbowled overs move
   *  - currently batting -> retired out first, then the above
   */
  async withdraw(matchId: string, dto: { player_id: string }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      this.assertRotation(match);
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;
      const eng: LiveInningsState | undefined = ls?.engine;

      const slot = (await client.query(
        `SELECT * FROM rotation_slots WHERE match_id = $1 AND player_id = $2`, [matchId, dto.player_id])).rows[0];
      if (!slot) throw new BadRequestException('That player is not in this match roster');
      if (slot.ended_reason) throw new BadRequestException('That player has already finished their innings');

      const isBatting = eng && eng.strikerId === dto.player_id;
      const hasBatted = !!slot.started_at;

      await this.closeSlot(client, matchId, dto.player_id, 'withdrawn');
      if (eng && !eng.battersCompleted?.includes(dto.player_id)) {
        eng.battersCompleted = [...(eng.battersCompleted ?? []), dto.player_id];
      }
      if (isBatting) {
        if (ls.batters?.[dto.player_id]) ls.batters[dto.player_id].out = true;
        ls.pending_new_batter = dto.player_id;
      }

      // Their unbowled overs have to go somewhere or the innings cannot be
      // completed — the scorer would hit BOWLER_QUOTA with nobody eligible.
      const remaining = (await client.query(
        `SELECT count(*)::int AS n FROM rotation_slots
          WHERE match_id = $1 AND player_id <> $2`, [matchId, dto.player_id])).rows[0].n;

      const next = await this.resize(client, match, ls, {
        batterCount: hasBatted
          ? (rules.solo_batting?.batter_count ?? 0)      // they used their slot; the pool is unchanged
          : (rules.solo_batting?.batter_count ?? 1) - 1, // they never batted; the innings gets shorter
        remainingBowlers: Math.max(1, remaining),
      });

      return { withdrawn: dto.player_id, had_batted: hasBatted, was_batting: isBatting, rules: next, state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'player_withdrawn' });
    return out;
  }

  // ----------------------------------------------------------------- resize
  /**
   * THE single writer for rotation's innings length.
   *
   * Root CLAUDE.md warns that innings length already lives in three places
   * (rules_snapshot.overs_per_innings, innings.max_overs, live_state.engine.maxOvers).
   * Rotation adds two more — solo_batting.batter_count and balls_per_batter —
   * plus the per-slot balls_allotted rows. Every one of them has to move
   * together or the termination check and the display disagree, so no call site
   * writes these fields directly.
   */
  private async resize(
    client: PoolClient,
    match: any,
    ls: any,
    opts: { batterCount?: number; ballsPerBatter?: number; remainingBowlers?: number },
  ): Promise<FormatRules> {
    const rules: FormatRules = structuredClone(match.rules_snapshot);
    const solo = rules.solo_batting!;
    const bpo = rules.balls_per_over ?? 6;

    const batterCount = opts.batterCount ?? solo.batter_count;
    const ballsPerBatter = opts.ballsPerBatter ?? solo.balls_per_batter;
    if (batterCount < 1) throw new BadRequestException('A rotation match needs at least one batter left');

    // 1 + 2. the solo block
    solo.batter_count = batterCount;
    solo.balls_per_batter = ballsPerBatter;
    // 3. the standard rule fields derived from it
    const totalBalls = batterCount * ballsPerBatter;
    rules.overs_per_innings = totalBalls / bpo;
    rules.players_per_side = batterCount + 1;
    rules.wickets_to_fall = batterCount;
    rules.max_overs_per_bowler = Math.ceil(rules.overs_per_innings / Math.max(1, opts.remainingBowlers ?? batterCount));

    await client.query(`UPDATE matches SET rules_snapshot = $2 WHERE id = $1`, [match.id, JSON.stringify(rules)]);

    // 4. the innings row
    if (ls?.innings_id) {
      await client.query(`UPDATE innings SET max_overs = $2 WHERE id = $1`, [ls.innings_id, rules.overs_per_innings]);
    }
    // 5. the live engine — the ONLY copy the termination check actually reads
    if (ls?.engine) ls.engine.maxOvers = rules.overs_per_innings;

    // 6. per-slot quotas for batters who have not started yet
    await client.query(
      `UPDATE rotation_slots SET balls_allotted = $2
        WHERE match_id = $1 AND started_at IS NULL AND ended_reason IS NULL`,
      [match.id, ballsPerBatter],
    );

    if (ls) {
      ls.rotation = await this.buildBlock(client, match.id, rules, ls.engine);
      await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [match.id, JSON.stringify(ls)]);
    }
    return rules;
  }

  /** Public entry point for a mid-match change to the per-batter allotment. */
  async setOversPerBatter(matchId: string, oversPerBatter: number) {
    return this.withMatch(matchId, async (client, match) => {
      this.assertRotation(match);
      const rules: FormatRules = match.rules_snapshot;
      if (!rules?.solo_batting?.enabled) throw new BadRequestException('Not a rotation match');
      if (oversPerBatter < 1) throw new BadRequestException('overs_per_batter must be at least 1');
      const bpo = rules.balls_per_over ?? 6;
      const ballsPerBatter = oversPerBatter * bpo;
      const ls = match.live_state;

      // Anyone already past the new allotment is finished the moment this lands.
      const overrun = (await client.query(
        `SELECT player_id FROM rotation_slots
          WHERE match_id = $1 AND ended_reason IS NULL AND balls_faced >= $2
          ORDER BY bat_order`,
        [matchId, ballsPerBatter],
      )).rows.map((r: any) => r.player_id);

      const next = await this.resize(client, match, ls, { ballsPerBatter });
      return {
        overs_per_batter: oversPerBatter,
        total_overs: next.overs_per_innings,
        closes_immediately: overrun,
        warning: overrun.length
          ? `${overrun.length} batter(s) are already past the new allotment and will be closed out.`
          : null,
      };
    });
  }

  // ------------------------------------------------------------- helpers
  /** Public read: the batting order and each slot's progress. */
  async slots(matchId: string): Promise<{ slots: RotationSlot[] }> {
    return { slots: await this.loadSlots(this.pool, matchId) };
  }

  async loadSlots(client: PoolClient | Pool, matchId: string): Promise<RotationSlot[]> {
    return (await client.query(
      `SELECT s.player_id, s.bat_order, s.balls_allotted, s.balls_faced, s.runs_scored,
              s.ended_reason, p.full_name AS name
         FROM rotation_slots s JOIN players p ON p.id = s.player_id
        WHERE s.match_id = $1 ORDER BY s.bat_order`,
      [matchId],
    )).rows;
  }

  private async closeSlot(client: PoolClient, matchId: string, playerId: string, reason: string) {
    await client.query(
      `UPDATE rotation_slots SET ended_reason = $3, ended_at = now()
        WHERE match_id = $1 AND player_id = $2 AND ended_reason IS NULL`,
      [matchId, playerId, reason],
    );
  }

  private async card(client: PoolClient, playerId: string) {
    const p = (await client.query(`SELECT full_name FROM players WHERE id = $1`, [playerId])).rows[0];
    return { name: p?.full_name ?? 'Unknown', runs: 0, balls: 0, fours: 0, sixes: 0, out: false };
  }

  private async bowlerCard(client: PoolClient, playerId: string) {
    const p = (await client.query(`SELECT full_name FROM players WHERE id = $1`, [playerId])).rows[0];
    return { name: p?.full_name ?? 'Unknown', legal_balls: 0, runs: 0, wickets: 0, maidens: 0 };
  }

  /**
   * The `rotation` block published in live_state. Namespaced deliberately: the
   * loadFromDb spread puts live_state keys OVER the match row's own columns, so
   * a top-level key colliding with a column name would shadow it (the
   * documented cause of the stale result_summary bug).
   */
  async buildBlock(
    client: PoolClient | Pool,
    matchId: string,
    rules: FormatRules,
    eng: LiveInningsState | null | undefined,
  ): Promise<any> {
    const solo = rules.solo_batting;
    if (!solo?.enabled) return undefined;
    const slots = await this.loadSlots(client, matchId);
    const bpo = rules.balls_per_over ?? 6;

    const strikerId = eng?.strikerId ?? null;
    const facedBy = (id: string) => eng?.batterLegalBalls?.[id] ?? 0;
    const completed = new Set(eng?.battersCompleted ?? []);

    const current = slots.find((s) => s.player_id === strikerId);
    const upcoming = slots.filter((s) => !completed.has(s.player_id) && s.player_id !== strikerId && !s.ended_reason);

    return {
      batter_count: solo.batter_count,
      balls_per_batter: solo.balls_per_batter,
      overs_per_batter: +(solo.balls_per_batter / bpo).toFixed(2),
      completed: completed.size,
      current_slot: current
        ? {
            bat_order: current.bat_order,
            player_id: current.player_id,
            name: current.name,
            balls_faced: facedBy(current.player_id),
            balls_left: Math.max(0, current.balls_allotted - facedBy(current.player_id)),
            runs: current.runs_scored,
          }
        : null,
      on_deck: upcoming[0]
        ? { bat_order: upcoming[0].bat_order, player_id: upcoming[0].player_id, name: upcoming[0].name }
        : null,
      remaining_batters: upcoming.map((s) => s.player_id),
      slots: slots.map((s) => ({
        bat_order: s.bat_order, player_id: s.player_id, name: s.name,
        balls_allotted: s.balls_allotted, balls_faced: s.balls_faced,
        runs_scored: s.runs_scored, ended_reason: s.ended_reason,
      })),
    };
  }
}

/** Fisher-Yates. A shuffled order is the fair default for a pickup game. */
function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
