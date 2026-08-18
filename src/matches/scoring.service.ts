import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { SaasService } from '../saas/saas.service';
import { deepMerge } from './matches.service';
import { LiveStateService } from './live-state.service';
import { RotationService } from './rotation.service';
import { applyBall, BallEvent, chaseCloseEffect, FormatRules, LiveInningsState, SideEffect } from './rules-engine';
import { StatsService } from './stats.service';

/**
 * How many recently-applied client_event_ids the live state carries. Only has
 * to outlast a scorer's in-flight outbox batch, so a couple of overs is ample.
 */
const APPLIED_EVENT_ID_HISTORY = 40;

/**
 * A match-ending outcome the rules engine can never produce, because it isn't
 * reachable from a delivery: the side batting (or due to bat) in the final
 * innings gave that innings up. Kept out of `SideEffect` so the engine stays a
 * pure function of the ball stream; `completeMatch` accepts it alongside the
 * engine's own effects.
 */
type ForfeitEffect = { kind: 'innings_forfeited' };

/**
 * The "A 34(21), B 12(9)" half of an over summary.
 *
 * Under last-man-standing (wickets_to_fall == players_per_side) the engine puts
 * the sole survivor in BOTH crease slots, so naively printing striker then
 * non-striker renders the same player twice. Collapse to one entry in that case.
 * The web parser anchors the bowler figures on the "O.B-M-R-W" pattern and takes
 * whatever precedes them as the batter line, so a shorter line is safe.
 */
const creaseLine = (
  striker: { name: string; runs: number; balls: number },
  nonStriker: { name: string; runs: number; balls: number },
  sameEnd: boolean,
): string =>
  sameEnd
    ? `${striker.name} ${striker.runs}(${striker.balls}) — last man batting`
    : `${striker.name} ${striker.runs}(${striker.balls}), ${nonStriker.name} ${nonStriker.runs}(${nonStriker.balls})`;

/**
 * Scoring engine over Postgres.
 * Concurrency: the match row is SELECT … FOR UPDATE for every mutation, and
 * clients pass expected_seq (optimistic check) + client_event_id (idempotency),
 * so duplicate taps, retries and stale scorers are all safe.
 * Live state lives in matches.live_state (polled via GET /matches/:id/state).
 */
@Injectable()
export class ScoringService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly stats: StatsService,
    private readonly live: LiveStateService,
    private readonly saas: SaasService,
    // Rotation setup/lifecycle. One-way: RotationService never imports this
    // service back, so there is no module cycle to untangle.
    private readonly rotation: RotationService,
  ) {}

  // ------------------------------------------------------------------ toss
  async toss(matchId: string, dto: { winner_team_id: string; decision: 'bat' | 'bowl' }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      if (match.status !== 'scheduled') throw new BadRequestException(`Toss already done (status: ${match.status})`);
      await this.saas.assertQuota(match.organization_id, 'max_concurrent_matches');
      if (![match.team_a_id, match.team_b_id].includes(dto.winner_team_id)) {
        throw new BadRequestException('Toss winner is not part of this match');
      }

      // Freeze rules: preset snapshot (super-over children) <- format rules <- tournament overrides
      let rules: FormatRules;
      if (match.rules_snapshot) {
        rules = match.rules_snapshot;
      } else if (match.tournament_id) {
        const result = (
          await client.query(
            `SELECT f.rules, t.rule_overrides FROM tournaments t
             JOIN match_formats f ON f.id = t.format_id WHERE t.id = $1`,
            [match.tournament_id],
          )
        ).rows;
        if (!result?.[0]) throw new BadRequestException(`Tournament ${match.tournament_id} or its format not found`);
        const t = result[0];
        rules = deepMerge(t.rules, t.rule_overrides);
      } else {
        const result = (await client.query(`SELECT rules FROM match_formats WHERE slug = 't20' AND is_builtin`)).rows;
        if (!result?.[0]) throw new BadRequestException('Default T20 format not found');
        rules = result[0].rules;
      }

      rules = await this.reconcileSquadSize(client, matchId, rules);

      const battingFirst =
        dto.decision === 'bat'
          ? dto.winner_team_id
          : dto.winner_team_id === match.team_a_id ? match.team_b_id : match.team_a_id;
      const bowlingFirst = battingFirst === match.team_a_id ? match.team_b_id : match.team_a_id;

      const innings = (
        await client.query(
          `INSERT INTO innings (match_id, seq, batting_team_id, bowling_team_id, status, max_overs)
           VALUES ($1, 1, $2, $3, 'not_started', $4) RETURNING id`,
          [matchId, battingFirst, bowlingFirst, rules.overs_per_innings],
        )
      ).rows[0];

      const liveState = {
        innings_id: innings.id,
        innings_seq: 1,
        engine: null,
        batters: {}, bowlers: {}, this_over: [], over_bowler_runs: 0,
        pending_new_batter: null,
        summary: await this.summaryShell(client, battingFirst, null),
      };
      await client.query(
        `UPDATE matches SET status = 'toss', toss_winner_id = $2, toss_decision = $3,
                rules_snapshot = $4, live_state = $5, actual_start = now() WHERE id = $1`,
        [matchId, dto.winner_team_id, dto.decision, JSON.stringify(rules), JSON.stringify(liveState)],
      );
      return { status: 'toss', innings_id: innings.id, rules_snapshot: rules };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'toss' });
    return out;
  }

  async undoToss(matchId: string) {
    const out = await this.withMatch(matchId, async (client, match) => {
      // Allow undo from either 'toss' (before openers) or 'innings_break' (after 1st innings).
      if (!['toss', 'innings_break'].includes(match.status)) {
        throw new BadRequestException(
          `Cannot undo toss from status: ${match.status} (only from 'toss' or 'innings_break' after first innings)`,
        );
      }
      // If in innings_break, verify there's only 1 completed innings (i.e., just finished innings 1).
      if (match.status === 'innings_break') {
        const innings = (await client.query(`SELECT count(*)::int AS n FROM innings WHERE match_id = $1`, [matchId]))
          .rows[0].n;
        if (innings > 1) {
          throw new BadRequestException(
            'Cannot undo toss after 2+ innings have started — use undo-innings-close instead',
          );
        }
      }
      // Delete all innings (the empty first one from toss, and any later incomplete ones)
      await client.query(`DELETE FROM innings WHERE match_id = $1`, [matchId]);
      // Reset all toss+scoring state
      await client.query(
        `UPDATE matches SET status = 'scheduled', toss_winner_id = NULL, toss_decision = NULL,
                            live_state = NULL, actual_start = NULL WHERE id = $1`,
        [matchId],
      );
      return { status: 'scheduled' };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'scheduled' });
    return out;
  }

  // ------------------------------------------------------------ settings
  async updateSettings(
    matchId: string,
    dto: {
      overs_per_innings?: number;
      players_per_side?: number;
      wickets_to_fall?: number;
      max_overs_per_bowler?: number | null;
      free_hit?: boolean;
      dls_enabled?: boolean;
    },
  ) {
    const out = await this.withMatch(matchId, async (client, match) => {
      // Settings can be edited at any point up to (but not after) the match is
      // decided, in any innings; they take effect from the next ball. Shortening
      // the innings is the one edit that can bite immediately — see below — but
      // a finished match's result must stay frozen.
      if (['completed', 'abandoned', 'no_result', 'cancelled', 'forfeited'].includes(match.status)) {
        throw new BadRequestException(
          `Cannot edit settings after the match is finished (status: ${match.status})`,
        );
      }

      // Start with existing rules_snapshot or build from format
      let rules: FormatRules;
      if (match.rules_snapshot) {
        rules = { ...match.rules_snapshot };
      } else if (match.tournament_id) {
        const t = (
          await client.query(
            `SELECT f.rules, t.rule_overrides FROM tournaments t
             JOIN match_formats f ON f.id = t.format_id WHERE t.id = $1`,
            [match.tournament_id],
          )
        ).rows[0];
        rules = deepMerge(t.rules, t.rule_overrides);
      } else {
        // Default T20
        const fmt = (
          await client.query(
            `SELECT rules FROM match_formats WHERE id = (SELECT id FROM match_formats WHERE name = 'T20 Internationals' LIMIT 1)`,
          )
        ).rows[0];
        rules = fmt?.rules || {};
      }

      const ls = match.live_state;
      const ballsPerOver = rules.balls_per_over ?? 6;

      // Validate overs_per_innings against the innings actually in play: the new
      // length has to leave room for every ball already bowled. Compared in
      // BALLS, not completed overs — at 2.3 overs a limit of 2 is already in the
      // past, even though `floor(15/6)` says only 2 overs are "complete".
      let closeInningsNow = false;
      if (dto.overs_per_innings !== undefined && dto.overs_per_innings > 0) {
        const legalBalls = ls?.engine?.legalBalls ?? 0;
        const allowedBalls = dto.overs_per_innings * ballsPerOver;
        if (legalBalls > allowedBalls) {
          throw new BadRequestException(
            `Cannot set overs per innings to ${dto.overs_per_innings} — ` +
            `${Math.floor(legalBalls / ballsPerOver)}.${legalBalls % ballsPerOver} overs have already been bowled in this innings`,
          );
        }

        // Ceiling for every innings after the first: a side that bats later can
        // never be handed MORE overs than a side that has already finished. The
        // first innings' allocation is what the chase was built around — raising
        // it now would hand the chasing team overs the side setting the target
        // never had. Reducing stays legal (that's the rain path).
        const cap = (
          await client.query(
            `SELECT min(max_overs)::float8 AS cap FROM innings
             WHERE match_id = $1 AND max_overs IS NOT NULL
               AND status IN ('completed', 'declared', 'forfeited')`,
            [matchId],
          )
        ).rows[0]?.cap ?? null;
        if (cap !== null && dto.overs_per_innings > cap) {
          throw new BadRequestException(
            `Cannot set overs per innings to ${dto.overs_per_innings} — ` +
            `a completed innings was only allocated ${+cap.toFixed(1)} overs, and a side ` +
            `batting later cannot get more. Reopen that innings if it was set up wrong.`,
          );
        }
        // Exactly at the new limit: the innings is over the moment the setting
        // lands. Nothing else can close it — the engine only tests the overs
        // limit while applying a ball, and no further ball is legal — so it
        // has to be closed here or the batting side keeps batting past its
        // own allocation.
        closeInningsNow = !!ls?.engine && legalBalls === allowedBalls;
      }

      // Update the settable fields in rules
      if (dto.overs_per_innings !== undefined) rules.overs_per_innings = dto.overs_per_innings;
      if (dto.players_per_side !== undefined) {
        rules.players_per_side = dto.players_per_side;
        // wickets_to_fall drives all-out detection and the "N all out" label.
        // Default to players_per_side − 1 (one batter left at crease), but allow explicit override
        // to support "last man batting" rule where wickets_to_fall = players_per_side.
        if (dto.wickets_to_fall === undefined) {
          rules.wickets_to_fall = Math.max(1, dto.players_per_side - 1);
        }
      }
      if (dto.wickets_to_fall !== undefined) rules.wickets_to_fall = dto.wickets_to_fall;
      if (dto.max_overs_per_bowler !== undefined) rules.max_overs_per_bowler = dto.max_overs_per_bowler;
      if (dto.free_hit !== undefined) {
        if (!rules.no_ball) rules.no_ball = { runs: 1, free_hit: dto.free_hit };
        else rules.no_ball.free_hit = dto.free_hit;
      }
      if (dto.dls_enabled !== undefined) {
        if (!rules.dls) rules.dls = { enabled: dto.dls_enabled, method: 'DLS' };
        else rules.dls.enabled = dto.dls_enabled;
      }

      // Update match rules_snapshot
      await client.query(`UPDATE matches SET rules_snapshot = $1 WHERE id = $2`, [rules, matchId]);

      // rules_snapshot alone only governs innings that haven't been created yet.
      // Each innings carries its OWN max_overs (the effective, rain-reducible
      // length), copied into live_state.engine.maxOvers when its openers are
      // picked — and that engine copy is what actually ends the innings. Without
      // pushing the change down to both, a mid-innings edit silently does
      // nothing to the innings being played (and an edit during the break does
      // nothing to the already-created next innings).
      let closed = false;
      let matchCompleted = false;
      if (dto.overs_per_innings !== undefined) {
        await client.query(
          `UPDATE innings SET max_overs = $2
           WHERE match_id = $1 AND status IN ('not_started', 'in_progress')`,
          [matchId, dto.overs_per_innings],
        );
        if (ls?.engine) ls.engine.maxOvers = dto.overs_per_innings;
      }

      if (closeInningsNow) {
        // Same two-step the ball path takes for an overs-exhausted innings, in
        // the same order: close the innings first, then settle the match if
        // this was the chase (completeInnings leaves live_state.engine alone
        // for the final innings precisely so completeMatch can read it).
        const chase = chaseCloseEffect(ls.engine, rules);
        await this.completeInnings(client, match, ls, rules, 'overs');
        closed = true;
        if (chase) {
          matchCompleted = true;
          await this.completeMatch(client, match, ls, rules, chase);
        }
      }

      if (ls) {
        if (ls.innings_id) ls.summary = await this.buildSummary(client, ls, rules);
        await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      }

      return {
        rules_snapshot: rules,
        status: match.status,
        innings_closed: closed,
        _matchCompleted: matchCompleted,
        _parent: match.parent_match_id,
      };
    });
    await this.live.syncAndPublish(matchId, 'settings', { rules_snapshot: out.rules_snapshot });
    if (out.innings_closed) {
      await this.live.syncAndPublish(matchId, 'status', {
        transition: out._matchCompleted ? 'match_completed' : 'innings_closed',
      });
    }
    if (out._matchCompleted) {
      await this.live.expireMatch(matchId);
      if (out._parent) await this.live.syncAndPublish(out._parent, 'status', { transition: 'super_over_result' });
      setImmediate(() => this.stats.finalizeMatch(matchId).catch((e) => console.error('stats finalize failed:', e.message)));
    }
    const { _matchCompleted, _parent, ...pub } = out;
    return pub;
  }

  // ------------------------------------------------------------ open innings
  async openers(matchId: string, dto: { striker_id: string; non_striker_id: string; bowler_id: string }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      const ls = match.live_state;
      // Normal case: toss just happened, or an innings break is pending openers.
      // Self-heal case: status is 'live' but no engine exists (e.g. an innings was
      // reopened after having 0 balls scored, so no striker/bowler could be
      // recovered by replay) — allow re-selecting openers instead of getting stuck.
      const canSetOpeners = ['toss', 'innings_break'].includes(match.status)
        || (match.status === 'live' && !ls?.engine);
      if (!canSetOpeners) {
        throw new BadRequestException(`Cannot set openers now (status: ${match.status})`);
      }
      if (ls?.follow_on_available) {
        throw new BadRequestException('Follow-on decision pending — POST /matches/:id/follow-on first');
      }
      if (!ls?.innings_id) throw new BadRequestException('No innings awaiting openers');
      const rules: FormatRules = match.rules_snapshot;
      await this.assertInXI(client, matchId, [dto.striker_id, dto.non_striker_id], 'bat');
      await this.assertInXI(client, matchId, [dto.bowler_id], 'bowl');
      if (dto.striker_id === dto.non_striker_id) throw new BadRequestException('Openers must be two different players');

      const innings = (
        await client.query(`SELECT * FROM innings WHERE id = $1`, [ls.innings_id])
      ).rows[0];

      const engine: LiveInningsState = {
        seq: Number(match.live_state_seq),
        totalRuns: 0, totalWickets: 0, legalBalls: 0,
        maxOvers: innings.max_overs !== null ? Number(innings.max_overs) : null,
        target: innings.target_runs,
        freeHitPending: false, currentOverBalls: 0, lastOverBowlerId: null,
        bowlerLegalBalls: {}, strikerId: dto.striker_id, nonStrikerId: dto.non_striker_id,
        battersRetiredHurt: [], batterLegalBalls: {}, battersCompleted: [],
      };
      ls.engine = engine;
      ls.current_bowler = dto.bowler_id;
      ls.batters = {
        [dto.striker_id]: await this.batterCard(client, dto.striker_id),
        [dto.non_striker_id]: await this.batterCard(client, dto.non_striker_id),
      };
      ls.bowlers = { [dto.bowler_id]: await this.bowlerCard(client, dto.bowler_id) };

      await client.query(
        `UPDATE innings SET status = 'in_progress', started_at = now() WHERE id = $1`,
        [ls.innings_id],
      );
      await client.query(
        `UPDATE matches SET status = 'live', live_state = $2 WHERE id = $1`,
        [matchId, JSON.stringify(ls)],
      );
      return { status: 'live', state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'live' });
    return out;
  }

  // ------------------------------------------------------------------ ball
  async ball(matchId: string, userId: string, dto: any) {
    const res: any = await this.withMatch(matchId, async (client, match) => {
      if (match.status !== 'live') throw new BadRequestException(`Match is not live (status: ${match.status})`);
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;
      if (!ls?.engine) throw new BadRequestException('Openers not set');
      if (ls.pending_new_batter) throw new ConflictException({ code: 'NEW_BATTER_REQUIRED', dismissed: ls.pending_new_batter });

      // Idempotency
      const dup = await client.query(
        `SELECT b.seq FROM balls b WHERE b.innings_id = $1 AND b.client_event_id = $2`,
        [ls.innings_id, dto.client_event_id],
      );
      if (dup.rowCount! > 0) return { code: 'DUPLICATE', seq: dup.rows[0].seq };

      // Optimistic concurrency
      if (dto.expected_seq !== undefined && dto.expected_seq !== Number(match.live_state_seq)) {
        throw new ConflictException({ code: 'SEQ_CONFLICT', current_seq: Number(match.live_state_seq) });
      }

      if (dto.wicket?.type === 'run_out' && !dto.wicket.wicket_broken_end) {
        throw new BadRequestException({ code: 'WICKET_BROKEN_END_REQUIRED', message: 'wicket_broken_end is required for run_out dismissals' });
      }

      const bowlerId = dto.bowler_id ?? ls.current_bowler;
      const ev: BallEvent = {
        strikerId: ls.engine.strikerId,
        nonStrikerId: ls.engine.nonStrikerId,
        bowlerId,
        runsBatter: dto.runs_batter ?? 0,
        extraType: dto.extra_type ?? null,
        runsExtras: dto.runs_extras ?? 0,
        secondaryExtraType: dto.extra_type === 'no_ball' ? (dto.secondary_extra_type ?? null) : null,
        wicket: dto.wicket
          ? { type: dto.wicket.type, dismissedPlayerId: dto.wicket.dismissed_player_id ?? ls.engine.strikerId, fielderId: dto.wicket.fielder_id, wicketBrokenEnd: dto.wicket.wicket_broken_end }
          : null,
      };

      const pre: LiveInningsState = ls.engine;
      const result = applyBall(pre, ev, rules);
      if (!result.ok) throw new ConflictException({ code: result.code, message: result.message });
      const post = result.next;

      // Total extras actually scored (automatic penalty + runs run).
      // A no-ball's runsExtras, when secondaryExtraType is set, is the
      // byes/leg-byes run off it — separate from the no-ball penalty but
      // still part of the ball's total extras.
      const isLegal = ev.extraType !== 'wide' && ev.extraType !== 'no_ball';
      let totalExtras = ev.runsExtras;
      if (ev.extraType === 'wide') totalExtras += rules.wide?.runs ?? 1;
      if (ev.extraType === 'no_ball') totalExtras += rules.no_ball?.runs ?? 1;
      const secondaryExtraRuns = ev.extraType === 'no_ball' && ev.secondaryExtraType ? ev.runsExtras : 0;

      const overNumber = Math.floor(pre.legalBalls / rules.balls_per_over);
      const ballInOver = pre.currentOverBalls + 1;
      const isFour = dto.is_boundary_four ?? (ev.runsBatter === 4);
      const isSix = dto.is_boundary_six ?? (ev.runsBatter === 6);

      const inserted = await client.query(
        `INSERT INTO balls (innings_id, seq, over_number, ball_in_over, striker_id, non_striker_id, bowler_id,
                            is_legal, runs_batter, runs_extras, extra_type, secondary_extra_type, secondary_extra_runs,
                            is_boundary_four, is_boundary_six,
                            is_free_hit, is_wicket, wicket_type, dismissed_player_id, fielder_id, wicket_broken_end,
                            wagon, pitch, shot_type, client_event_id, scored_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING id, seq`,
        [ls.innings_id, post.seq, overNumber, ballInOver, ev.strikerId, ev.nonStrikerId, bowlerId,
         isLegal, ev.runsBatter, totalExtras, ev.extraType, ev.secondaryExtraType ?? null, secondaryExtraRuns,
         isFour, isSix,
         pre.freeHitPending, !!ev.wicket, ev.wicket?.type ?? null, ev.wicket?.dismissedPlayerId ?? null,
         ev.wicket?.fielderId ?? null, ev.wicket?.wicketBrokenEnd ?? null,
         dto.wagon ? JSON.stringify(dto.wagon) : null, dto.pitch ? JSON.stringify(dto.pitch) : null,
         dto.shot_type ?? null, dto.client_event_id, userId],
      );

      // Innings counters. Byes/leg-byes always exclude the no-ball penalty
      // (extras_no_balls), and a no-ball's byes/leg-byes component (if any)
      // is routed to extras_byes/extras_leg_byes just like a plain bye —
      // never lumped into extras_no_balls or dropped.
      await client.query(
        `UPDATE innings SET total_runs = $2, total_wickets = $3, legal_balls = $4,
                extras_wides = extras_wides + $5, extras_no_balls = extras_no_balls + $6,
                extras_byes = extras_byes + $7, extras_leg_byes = extras_leg_byes + $8
         WHERE id = $1`,
        [ls.innings_id, post.totalRuns, post.totalWickets, post.legalBalls,
         ev.extraType === 'wide' ? totalExtras : 0,
         ev.extraType === 'no_ball' ? rules.no_ball?.runs ?? 1 : 0,
         ev.extraType === 'bye' ? ev.runsExtras : (ev.secondaryExtraType === 'bye' ? secondaryExtraRuns : 0),
         ev.extraType === 'leg_bye' ? ev.runsExtras : (ev.secondaryExtraType === 'leg_bye' ? secondaryExtraRuns : 0)],
      );

      // Over summary (bowler charged with batter runs + wide/no-ball extras —
      // byes/leg-byes are never charged to the bowler, even the ones run
      // off a no-ball, so the secondary component is excluded here).
      const bowlerRuns = ev.runsBatter + (['wide', 'no_ball'].includes(ev.extraType ?? '') ? totalExtras - secondaryExtraRuns : 0);
      await client.query(
        `INSERT INTO over_summaries (innings_id, over_number, bowler_id, runs, wickets, extras,
                                     cumulative_runs, cumulative_wickets)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (innings_id, over_number) DO UPDATE SET
           runs = over_summaries.runs + excluded.runs,
           wickets = over_summaries.wickets + excluded.wickets,
           extras = over_summaries.extras + excluded.extras,
           cumulative_runs = excluded.cumulative_runs,
           cumulative_wickets = excluded.cumulative_wickets`,
        [ls.innings_id, overNumber, bowlerId, ev.runsBatter + totalExtras, ev.wicket ? 1 : 0, totalExtras,
         post.totalRuns, post.totalWickets],
      );

      // ---- Update live display state ----
      ls.engine = post;
      const bat = (ls.batters[ev.strikerId] ??= await this.batterCard(client, ev.strikerId));
      if (isLegal || ev.extraType === 'no_ball') {
        if (ev.extraType !== 'wide') { bat.balls += 1; }
        bat.runs += ev.runsBatter;
        if (isFour) bat.fours += 1;
        if (isSix) bat.sixes += 1;
      }
      const bowl = (ls.bowlers[bowlerId] ??= await this.bowlerCard(client, bowlerId));
      if (isLegal) bowl.legal_balls += 1;
      bowl.runs += bowlerRuns;
      ls.over_bowler_runs = (overNumber === Math.floor(post.legalBalls / rules.balls_per_over) || !isLegal)
        ? (ls.over_bowler_runs ?? 0) + bowlerRuns
        : 0; // reset handled at over_complete below
      if (ev.wicket && !['run_out', 'retired_hurt', 'retired_out', 'obstructing_field', 'timed_out'].includes(ev.wicket.type)) {
        bowl.wickets += 1;
      }
      ls.this_over.push(this.ballLabel(ev, isFour, isSix));
      ls.current_bowler = bowlerId;

      // ---- Auto ball-by-ball commentary ----
      const isHighlight = !!ev.wicket || isFour || isSix;
      const wicketNames = ev.wicket
        ? {
            dismissed: await this.playerName(client, ev.wicket.dismissedPlayerId),
            fielder: await this.playerName(client, ev.wicket.fielderId),
          }
        : {};
      await client.query(
        `INSERT INTO commentary_entries (match_id, innings_id, ball_id, source, body, is_highlight)
         VALUES ($1, $2, $3, 'auto', $4, $5)`,
        [matchId, ls.innings_id, inserted.rows[0].id,
         this.commentaryText(overNumber, ballInOver, bowl.name, bat.name, ev, totalExtras, isFour, isSix, post,
           dto.wagon?.region ?? null, wicketNames),
         isHighlight],
      );

      // ---- Effects ----
      let matchCompleted = false;
      for (const ef of result.effects) {
        if (ef.kind === 'over_complete') {
          // A maiden is a completed over where the bowler conceded zero
          // runs — byes and leg-byes (including any run off a no-ball)
          // don't count against the bowler, so they must NOT break a
          // maiden. over_summaries.runs mixes those in, so compute the
          // bowler-charged total for this over directly from the ball
          // stream instead.
          const overAgg = (await client.query(
            `SELECT coalesce(sum(runs_batter + CASE WHEN extra_type IN ('wide','no_ball')
                     THEN runs_extras - secondary_extra_runs ELSE 0 END), 0)::int AS runs,
                    coalesce(sum(runs_batter + runs_extras), 0)::int AS total_over_runs,
                    count(*) FILTER (WHERE is_wicket AND wicket_type NOT IN
                      ('run_out','retired_hurt','retired_out','obstructing_field','timed_out'))::int AS bowler_wickets,
                    count(*) FILTER (WHERE is_wicket)::int AS wickets_in_over
             FROM balls WHERE innings_id = $1 AND over_number = $2 AND NOT is_superseded`,
            [ls.innings_id, ef.overNumber],
          )).rows[0];
          const isMaidenOver = overAgg.runs === 0;
          // Wicket maiden: a maiden in which the bowler also took ≥1 wicket
          // (bowler-credited dismissals only — a run-out doesn't count).
          const isWicketMaiden = isMaidenOver && overAgg.bowler_wickets > 0;
          // Any wicket this over (including run-outs) that isn't already
          // called out via the wicket-maiden badge.
          const overWickets = overAgg.wickets_in_over as number;
          await client.query(
            `UPDATE over_summaries SET is_maiden = $3 WHERE innings_id = $1 AND over_number = $2`,
            [ls.innings_id, ef.overNumber, isMaidenOver],
          );
          if (isMaidenOver) bowl.maidens += 1;
          ls.this_over = [];
          ls.over_bowler_runs = 0;

          // ---- Over summary commentary (both batters' scores + this over's bowler figures) ----
          const strikerCard = (ls.batters[post.strikerId] ??= await this.batterCard(client, post.strikerId));
          const nonStrikerCard = (ls.batters[post.nonStrikerId] ??= await this.batterCard(client, post.nonStrikerId));
          const bpo = rules.balls_per_over ?? 6;
          const bowlerFigures = `${Math.floor(bowl.legal_balls / bpo)}.${bowl.legal_balls % bpo}-${bowl.maidens}-${bowl.runs}-${bowl.wickets}`;
          await client.query(
            // created_at nudged +1ms so this summary sorts above the ball that ended the over
            // (Postgres now() is frozen per-transaction, so both inserts would otherwise tie)
            `INSERT INTO commentary_entries (match_id, innings_id, ball_id, source, body, is_highlight, created_at)
             VALUES ($1, $2, $3, 'auto', $4, $5, now() + interval '1 millisecond')`,
            [matchId, ls.innings_id, inserted.rows[0].id,
             `End of over ${ef.overNumber + 1} — ${overAgg.total_over_runs} runs: ${post.totalRuns}/${post.totalWickets}. ` +
               (isWicketMaiden ? 'WICKET MAIDEN! '
                 : isMaidenOver ? 'Maiden over! '
                 : overWickets > 0 ? `${overWickets} WICKET${overWickets > 1 ? 'S' : ''}! ` : '') +
               `${creaseLine(strikerCard, nonStrikerCard, post.strikerId === post.nonStrikerId)}. ` +
               `${bowl.name} ${bowlerFigures}`,
             isMaidenOver || overWickets > 0],
          );
        }
        if (ef.kind === 'new_batter_required') {
          const stillBatting = post.totalWickets < rules.wickets_to_fall;
          const inningsEnding = result.effects.some((e) => e.kind === 'innings_complete');
          if (stillBatting && !inningsEnding) ls.pending_new_batter = ef.dismissedId;
        }
        if (ef.kind === 'innings_complete') {
          await this.completeInnings(client, match, ls, rules, ef.reason);
        }
        if (ef.kind === 'match_complete' || ef.kind === 'super_over_required') {
          matchCompleted = true;
          await this.completeMatch(client, match, ls, rules, ef);
        }
      }

      // ---- Rotation mode bookkeeping -------------------------------------
      // Inside the same transaction as the ball, so rotation_slots can never
      // disagree with the ball stream it is derived from.
      if (rules.solo_batting?.enabled) {
        await client.query(
          `UPDATE rotation_slots
              SET balls_faced = balls_faced + $3, runs_scored = runs_scored + $4,
                  started_at = coalesce(started_at, now())
            WHERE match_id = $1 AND player_id = $2`,
          [matchId, ev.strikerId, isLegal ? 1 : 0, ev.runsBatter],
        );
        await client.query(
          `UPDATE rotation_bowl_quota
              SET legal_balls = legal_balls + $3, last_over_number = $4
            WHERE match_id = $1 AND player_id = $2`,
          [matchId, bowlerId, isLegal ? 1 : 0, overNumber],
        );
        // A quota retirement is not a dismissal, so nothing else closes the
        // slot — but the batter is just as finished.
        const retired = result.effects.find((e) => e.kind === 'batter_retired');
        if (retired) {
          await client.query(
            `UPDATE rotation_slots SET ended_reason = 'quota', ended_at = now()
              WHERE match_id = $1 AND player_id = $2 AND ended_reason IS NULL`,
            [matchId, (retired as { playerId: string }).playerId],
          );
          const card = ls.batters?.[(retired as { playerId: string }).playerId];
          if (card) card.out = true;
        }
        if (ev.wicket && ev.wicket.type !== 'retired_hurt') {
          await client.query(
            `UPDATE rotation_slots SET ended_reason = $3, ended_at = now()
              WHERE match_id = $1 AND player_id = $2 AND ended_reason IS NULL`,
            [matchId, ev.wicket.dismissedPlayerId,
             ev.wicket.type === 'retired_out' ? 'voluntary' : 'dismissed'],
          );
        }
        ls.rotation = await this.rotation.buildBlock(client, matchId, rules, post);
      }

      ls.summary = await this.buildSummary(client, ls, rules);

      // Rolling record of the client_event_ids this state already includes.
      // A scorer's outbox holds a ball until its HTTP batch response returns,
      // but the websocket broadcast of the applied state races ahead of that
      // response — without this, the client would fold a ball onto a state
      // that already contains it and paint the delivery twice. Publishing the
      // ids lets the client drop exactly the balls the server has absorbed.
      ls.applied_event_ids = [
        ...(ls.applied_event_ids ?? []),
        dto.client_event_id,
      ].slice(-APPLIED_EVENT_ID_HISTORY);

      await client.query(
        `UPDATE matches SET live_state = $2, live_state_seq = $3 WHERE id = $1`,
        [matchId, JSON.stringify(ls), post.seq],
      );

      return {
        seq: post.seq, ball_id: inserted.rows[0].id,
        effects: result.effects.map((e) => e.kind), state: ls,
        _completed: matchCompleted, _parent: match.parent_match_id,
        _ball: {
          seq: post.seq, over: overNumber, ball_in_over: ballInOver,
          label: this.ballLabel(ev, isFour, isSix),
          runs_batter: ev.runsBatter, extras: totalExtras, extra_type: ev.extraType,
          wicket: ev.wicket?.type ?? null, score: `${post.totalRuns}/${post.totalWickets}`,
        },
      };
    });

    // Duplicate replays skip Redis — nothing changed
    if (res.code === 'DUPLICATE') return res;

    // ---- Post-commit: Redis write-through + real-time fan-out ----
    await this.live.pushBall(matchId, res._ball);
    await this.live.syncAndPublish(matchId, 'ball', { seq: res.seq, effects: res.effects, delta: res._ball });

    if (res._completed) {
      await this.live.expireMatch(matchId);
      // Super-over children propagate their result onto the parent match
      if (res._parent) await this.live.syncAndPublish(res._parent, 'status', { transition: 'super_over_result' });
      // Stats run after the scoring TX commits
      setImmediate(() => this.stats.finalizeMatch(matchId).catch((e) => console.error('stats finalize failed:', e.message)));
    }

    const { _completed, _parent, _ball, ...pub } = res;
    return pub;
  }

  // ------------------------------------------------------------- new batter
  async newBatter(matchId: string, dto: { player_id: string; wicket_broken_end?: 'striker' | 'non_striker'; over_action?: string }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      const ls = match.live_state;
      if (!ls?.pending_new_batter) throw new BadRequestException('No new batter required');
      await this.assertInXI(client, matchId, [dto.player_id], 'bat');
      if (ls.batters[dto.player_id]?.out) throw new BadRequestException('Player is already out');

      const rules: FormatRules = match.rules_snapshot;
      const solo = rules?.solo_batting?.enabled === true;
      const dismissed = ls.pending_new_batter;

      // For gully cricket mid-over dismissals: if user selects "start new over",
      // reset the over counter to 0 so the next bowler starts a fresh over.
      if (solo && dto.over_action === 'new_over' && ls.engine.currentOverBalls > 0) {
        // Reset the over balls counter for a fresh over start
        ls.engine.currentOverBalls = 0;
        // Note: lastOverBowlerId stays as is - it represents the bowler of the
        // last COMPLETED over, not the incomplete one being reset
      }

      if (solo) {
        // Rotation mode: the outgoing batter occupies BOTH ends, so replacing
        // only the matching slot would leave nonStrikerId pointing at a batter
        // who has left the field — and the striker === nonStriker invariant
        // that makes strike rotation a no-op would be broken from here on.
        if (ls.engine.strikerId !== dismissed && ls.engine.nonStrikerId !== dismissed) {
          throw new BadRequestException('Live state is out of step with the pending batter — resync required');
        }
        ls.engine.strikerId = dto.player_id;
        ls.engine.nonStrikerId = dto.player_id;
      } else if (ls.engine.strikerId === dismissed) {
        ls.engine.strikerId = dto.player_id;
      } else if (ls.engine.nonStrikerId === dismissed) {
        ls.engine.nonStrikerId = dto.player_id;
      } else {
        ls.engine.strikerId = dto.player_id; // safety net
      }

      (ls.batters[dismissed] ??= await this.batterCard(client, dismissed)).out = true;
      ls.batters[dto.player_id] ??= await this.batterCard(client, dto.player_id);
      ls.pending_new_batter = null;

      if (solo) {
        // Rotation mode: force bowler selection for the new batter. Even if a bowler
        // was bowling before the dismissal, they must be explicitly chosen again.
        // This enforces the no-consecutive-overs rule mid-over.
        ls.current_bowler = null;
        // Hand the batting slot over: close the outgoing one if the ball path
        // has not already (a quota retirement closes it there), open the new.
        await client.query(
          `UPDATE rotation_slots SET ended_reason = coalesce(ended_reason, 'dismissed'), ended_at = coalesce(ended_at, now())
            WHERE match_id = $1 AND player_id = $2`,
          [matchId, dismissed],
        );
        await client.query(
          `UPDATE rotation_slots SET started_at = coalesce(started_at, now())
            WHERE match_id = $1 AND player_id = $2`,
          [matchId, dto.player_id],
        );
        ls.rotation = await this.rotation.buildBlock(client, matchId, rules, ls.engine);
      }

      await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      return { state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'new_batter' });
    return out;
  }

  // ------------------------------------------------------------------ undo
  /** Supersedes the last ball and rebuilds the innings by replaying the event stream. */
  async undoLast(matchId: string) {
    const out = await this.withMatch(matchId, async (client, match) => {
      const ls = match.live_state;
      if (!ls?.innings_id) throw new BadRequestException('Nothing to undo');
      const last = (
        await client.query(
          `SELECT id FROM balls WHERE innings_id = $1 AND NOT is_superseded ORDER BY seq DESC LIMIT 1`,
          [ls.innings_id],
        )
      ).rows[0];

      // No deliveries left in the current innings. Never dead-end on "No balls
      // to undo" — take the sensible step back:
      //  (a) if an earlier innings can be reopened, step across the boundary
      //      into it (recovery when a correction turned the balls that closed an
      //      innings into wides, stranding play at the top of the next, empty
      //      innings); otherwise
      //  (b) this is the first innings with every ball already taken back —
      //      replay it, which with zero balls resets the console to opener
      //      selection (engine cleared, status → innings_break) so the scorer
      //      can restart cleanly rather than being stuck.
      if (!last) {
        const innings = (
          await client.query(`SELECT id, seq, status FROM innings WHERE match_id = $1 ORDER BY seq`, [match.id])
        ).rows;
        const current = innings.find((i) => i.id === ls.innings_id);
        const prev = current ? innings.filter((i) => i.seq < current.seq).pop() : null;
        if (prev && ['completed', 'declared', 'forfeited'].includes(prev.status)) {
          const reopened = await this.reopenPreviousInnings(client, match, ls);
          return { reopened_innings: reopened.seq, state: reopened.state };
        }
        const reset = await this.replayInnings(client, match, ls.innings_id);
        return { reset_openers: true, state: reset };
      }

      await client.query(`UPDATE balls SET is_superseded = true WHERE id = $1`, [last.id]);
      // Remove every commentary row tied to the undone ball — not just the auto
      // narration but also manual fielding events (dropped catch / run out
      // missed / misfield) that addCommentary pinned to it. replayInnings only
      // rebuilds auto entries, so without this the fielding note would linger in
      // the feed after its ball was taken back.
      await client.query(`DELETE FROM commentary_entries WHERE ball_id = $1`, [last.id]);
      const rebuilt = await this.replayInnings(client, match, ls.innings_id);
      return { undone: last.id, state: rebuilt };
    });
    // Corrections tell clients to discard local state and adopt the snapshot
    await this.live.syncAndPublish(
      matchId, 'correction',
      out.undone ? { undone: out.undone }
        : out.reset_openers ? { transition: 'openers_reset' }
        : { transition: 'innings_reopened' },
    );
    return out;
  }

  /**
   * Reopen the innings immediately before the current one and make it live
   * again, discarding the now-empty current innings. Shared recovery step for
   * undo when the current innings has no ball left to take back. Throws if
   * there is no previous innings in a reopenable state.
   */
  private async reopenPreviousInnings(client: PoolClient, match: any, ls: any) {
    const innings = (
      await client.query(`SELECT * FROM innings WHERE match_id = $1 ORDER BY seq`, [match.id])
    ).rows;
    const current = innings.find((i) => i.id === ls.innings_id);
    if (!current) throw new BadRequestException('No earlier innings to step back into');
    const prev = innings.filter((i) => i.seq < current.seq).pop();
    if (!prev || !['completed', 'declared', 'forfeited'].includes(prev.status)) {
      throw new BadRequestException('No earlier innings to step back into');
    }

    // Drop the empty current innings. Its commentary must go first: commentary
    // rows reference balls via ball_id with no cascade, so the innings→balls
    // cascade would otherwise be blocked.
    await client.query(`DELETE FROM commentary_entries WHERE innings_id = $1`, [current.id]);
    await client.query(`DELETE FROM innings WHERE id = $1`, [current.id]);

    // Reopen the previous innings. Clear its stale "End of innings" auto card
    // (ball_id IS NULL, so replayInnings' ball-keyed rebuild leaves it behind),
    // then replay to rebuild live_state and flip the match status back to live.
    await client.query(
      `UPDATE innings SET status = 'in_progress', ended_at = NULL WHERE id = $1`,
      [prev.id],
    );
    await client.query(
      `DELETE FROM commentary_entries WHERE innings_id = $1 AND source = 'auto' AND ball_id IS NULL`,
      [prev.id],
    );
    ls.innings_id = prev.id;
    ls.innings_seq = prev.seq;
    ls.follow_on_available = null;
    ls.follow_on_decision = null;
    const state = await this.replayInnings(client, match, prev.id);
    return { seq: prev.seq, state };
  }

  /** Correct any non-superseded ball: supersede the original, insert a corrected copy at the same seq, replay the innings. */
  async editBall(matchId: string, ballId: string, dto: {
    runs_batter?: number; extra_type?: string; runs_extras?: number;
    secondary_extra_type?: string; secondary_extra_runs?: number;
    is_boundary_four?: boolean; is_boundary_six?: boolean;
    wicket_type?: string; dismissed_player_id?: string; fielder_id?: string; wicket_broken_end?: string;
  }, userId: string) {
    const out = await this.withMatch(matchId, async (client, match) => {
      const rules: FormatRules = match.rules_snapshot;

      // 1. Find the original ball and confirm it belongs to this match
      const orig = (await client.query(
        `SELECT b.* FROM balls b JOIN innings i ON i.id = b.innings_id
         WHERE b.id = $1 AND i.match_id = $2 AND NOT b.is_superseded`,
        [ballId, matchId],
      )).rows[0];
      if (!orig) throw new NotFoundException('Ball not found');

      // 2. Derive stored-extras (same formula as scoreBall)
      const autoPenalty = dto.extra_type === 'wide' ? (rules.wide?.runs ?? 1)
        : dto.extra_type === 'no_ball' ? (rules.no_ball?.runs ?? 1) : 0;
      const totalExtras = (dto.extra_type ? autoPenalty : 0) + (dto.runs_extras ?? 0);
      const isLegal = dto.extra_type !== 'wide' && dto.extra_type !== 'no_ball';
      const isFour = dto.is_boundary_four ?? false;
      const isSix = dto.is_boundary_six ?? false;

      // 3. Supersede original
      await client.query('UPDATE balls SET is_superseded = true WHERE id = $1', [ballId]);

      // 4. Insert corrected ball at the same seq position
      const { rows: [{ id: newBallId }] } = await client.query(
        `INSERT INTO balls (innings_id, seq, over_number, ball_in_over,
                            striker_id, non_striker_id, bowler_id,
                            is_legal, runs_batter, runs_extras, extra_type,
                            secondary_extra_type, secondary_extra_runs,
                            is_boundary_four, is_boundary_six, is_free_hit,
                            is_wicket, wicket_type, dismissed_player_id, fielder_id, wicket_broken_end,
                            wagon, pitch, shot_type, client_event_id, scored_by, supersedes_ball_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                 gen_random_uuid(),$25,$26)
         RETURNING id`,
        [orig.innings_id, orig.seq, orig.over_number, orig.ball_in_over,
          orig.striker_id, orig.non_striker_id, orig.bowler_id,
          isLegal, dto.runs_batter ?? 0, totalExtras, dto.extra_type ?? null,
          dto.secondary_extra_type ?? null, dto.secondary_extra_runs ?? 0,
          isFour, isSix, orig.is_free_hit,
          !!dto.wicket_type, dto.wicket_type ?? null,
          dto.dismissed_player_id ?? orig.striker_id, dto.fielder_id ?? null, dto.wicket_broken_end ?? null,
          orig.wagon, orig.pitch, orig.shot_type, userId, ballId],
      );

      // 5. Full innings replay rebuilds every derived value — cards, over
      //    summaries, innings totals and the whole auto commentary feed. The
      //    commentary must be rebuilt wholesale rather than just for this ball:
      //    each body embeds the running score, so every later ball is stale
      //    too, and the end-of-over summary hangs off the same ball_id as the
      //    ball that closed the over.
      const rebuilt = await this.replayInnings(client, match, orig.innings_id);
      return { edited: newBallId, state: rebuilt };
    });
    await this.live.syncAndPublish(matchId, 'correction', { edited: out.edited });
    return out;
  }

  // ------------------------------------------------- manual innings control
  async closeInningsManual(matchId: string, reason: 'declared' | 'overs' | 'all_out' | 'forfeited') {
    const out = await this.withMatch(matchId, async (client, match) => {
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;
      if (!ls?.innings_id) throw new BadRequestException('No active innings');
      if (reason === 'declared' && !rules.declaration_allowed) {
        throw new BadRequestException('Declaration is not allowed in this format');
      }

      // Closing the FINAL innings has to settle the match right here.
      // completeInnings deliberately returns early for it ("match end handled
      // by match_complete effect"), leaving live_state.engine intact so the
      // chase total stays readable — but on the ball path that effect comes
      // from the engine, and nothing follows a manual close. Same two-step, in
      // the same order, as the closeInningsNow block in updateSettings.
      const totalInnings = (rules.innings_per_side ?? 1) * 2;
      const isFinalInnings = (ls.innings_seq ?? 0) >= totalInnings;

      // The engine is legitimately absent when the final innings is given up
      // before its openers are picked (a side forfeiting without batting).
      // Stand in with the innings row's own figures so the verdict and the
      // winning margin still have a chase total, target and overs to read, then
      // put live_state back as it was — a match that never got under way must
      // not publish a phantom engine state.
      const engineWasMissing = isFinalInnings && !ls.engine;
      if (engineWasMissing) ls.engine = await this.engineFromInningsRow(client, ls.innings_id);

      // A forfeit is not a chase verdict. The side that walked away loses
      // outright whatever the scoreboard says: level scores are a win by
      // forfeit, never a tie, and must never send the match to a super over.
      const effect: SideEffect | ForfeitEffect | null = !isFinalInnings ? null
        : reason === 'forfeited' ? { kind: 'innings_forfeited' }
        : chaseCloseEffect(ls.engine, rules);

      await this.completeInnings(client, match, ls, rules, reason);
      let matchCompleted = false;
      if (effect) {
        matchCompleted = true;
        await this.completeMatch(client, match, ls, rules, effect);
      }
      if (engineWasMissing) ls.engine = null;

      if (ls.innings_id) ls.summary = await this.buildSummary(client, ls, rules);
      await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      return { state: ls, _matchCompleted: matchCompleted, _parent: match.parent_match_id };
    });
    await this.live.syncAndPublish(matchId, 'status', {
      transition: out._matchCompleted ? 'match_completed' : 'innings_closed',
    });
    if (out._matchCompleted) {
      await this.live.expireMatch(matchId);
      // Super-over children propagate their result onto the parent match
      if (out._parent) await this.live.syncAndPublish(out._parent, 'status', { transition: 'super_over_result' });
      setImmediate(() => this.stats.finalizeMatch(matchId).catch((e) => console.error('stats finalize failed:', e.message)));
    }
    const { _matchCompleted, _parent, ...pub } = out;
    return pub;
  }

  /**
   * Stand-in engine state for an innings that has none — closed before its
   * openers were picked. Only the scoring figures are real (they come off the
   * innings row); the batter/bowler fields are placeholders, so this is for
   * reading a result out of, never for applying a ball to.
   */
  private async engineFromInningsRow(client: PoolClient, inningsId: string): Promise<LiveInningsState> {
    const inn = (
      await client.query(
        `SELECT total_runs, total_wickets, legal_balls, max_overs, target_runs FROM innings WHERE id = $1`,
        [inningsId],
      )
    ).rows[0];
    return {
      seq: 0,
      totalRuns: inn.total_runs, totalWickets: inn.total_wickets, legalBalls: inn.legal_balls,
      maxOvers: inn.max_overs !== null ? Number(inn.max_overs) : null,
      target: inn.target_runs,
      freeHitPending: false, currentOverBalls: 0, lastOverBowlerId: null,
      bowlerLegalBalls: {}, strikerId: '', nonStrikerId: '', battersRetiredHurt: [],
      batterLegalBalls: {}, battersCompleted: [],
    };
  }

  // -------------------------------------------------- reopen innings (undo close/declare)
  /**
   * Undo an innings close (accidental declare / early close). Only possible
   * while the next innings hasn't started (no balls scored, no openers).
   * Deletes the empty next innings, reopens the previous one, and rebuilds
   * live state by replaying its ball stream.
   */
  async reopenInnings(matchId: string) {
    const out = await this.withMatch(matchId, async (client, match) => {
      if (!['innings_break', 'live', 'toss'].includes(match.status)) {
        throw new BadRequestException(`Cannot reopen an innings now (status: ${match.status})`);
      }
      const ls = match.live_state;
      const innings = (
        await client.query(`SELECT * FROM innings WHERE match_id = $1 ORDER BY seq`, [matchId])
      ).rows;
      if (innings.length === 0) throw new BadRequestException('No innings to reopen');

      let toReopen: any;
      if (ls?.follow_on_available) {
        // Break happened at the follow-on decision point — no next innings exists yet
        toReopen = innings[innings.length - 1];
      } else {
        const current = innings.find((i) => i.id === ls?.innings_id);
        if (!current) throw new BadRequestException('No innings context to reopen');

        if (['completed', 'declared', 'forfeited'].includes(current.status)) {
          // Innings just completed and the match paused before the next was created.
          toReopen = current;
        } else {
          // Current innings is still open (in_progress or not_started). If it
          // holds any live delivery, the user must take balls back one at a
          // time. If it's empty — freshly opened, or every delivery was
          // superseded by corrections leaving play stranded at its top — step
          // back into the previous innings (also the normal undo-a-declare case
          // where the next innings hasn't started). Delegates to the shared
          // helper, which drops this empty innings and reopens the prior one.
          const active = await client.query(
            `SELECT 1 FROM balls WHERE innings_id = $1 AND NOT is_superseded LIMIT 1`,
            [current.id],
          );
          if (active.rowCount! > 0 || current.seq === 1) {
            throw new BadRequestException('Innings is already open — use ball undo instead');
          }
          const reopened = await this.reopenPreviousInnings(client, match, ls);
          return { reopened_innings: reopened.seq, state: reopened.state };
        }
      }
      if (!toReopen || !['completed', 'declared', 'forfeited'].includes(toReopen.status)) {
        throw new BadRequestException('Previous innings is not in a reopenable state');
      }

      await client.query(
        `UPDATE innings SET status = 'in_progress', ended_at = NULL WHERE id = $1`,
        [toReopen.id],
      );
      ls.innings_id = toReopen.id;
      ls.innings_seq = toReopen.seq;
      ls.follow_on_available = null;
      ls.follow_on_decision = null;
      const rebuilt = await this.replayInnings(client, match, toReopen.id);
      return { reopened_innings: toReopen.seq, state: rebuilt };
    });
    // Clients discard local state and adopt the snapshot, like an undo
    await this.live.syncAndPublish(matchId, 'correction', { transition: 'innings_reopened' });
    return out;
  }

  // ---------------------------------------------------- follow-on (Tests)
  /**
   * After the 2nd innings of a 2-innings-per-side match, if the side batting
   * first leads by ≥ rules.follow_on.deficit, the scorer must decide:
   * enforce (opponent bats again, is_follow_on=true) or bat normally.
   */
  async followOn(matchId: string, dto: { enforce: boolean }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;
      if (!ls?.follow_on_available) throw new BadRequestException('No follow-on decision is pending');

      const done = (
        await client.query(
          `SELECT seq, batting_team_id, total_runs FROM innings WHERE match_id = $1 ORDER BY seq`,
          [matchId],
        )
      ).rows;
      const decision = { ...ls.follow_on_available, enforced: dto.enforce };
      ls.follow_on_available = null;
      ls.follow_on_decision = decision;
      await this.createNextInnings(client, match, ls, rules, done, dto.enforce);
      await client.query(`UPDATE matches SET live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      return { follow_on: decision, state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'follow_on_decision' });
    return out;
  }

  // ------------------------------------------------------------ super over
  /**
   * Tied match → create a linked child match (parent_match_id) with super-over
   * rules: 1 over per side, 2 wickets, 1 over per bowler. The child is scored
   * through the normal toss→openers→balls flow; on completion its result is
   * written back onto the parent.
   */
  async createSuperOver(matchId: string) {
    const child = await this.withMatch(matchId, async (client, match) => {
      if (match.status !== 'completed' || match.result_type !== 'tie') {
        throw new BadRequestException('A super over can only follow a tied, completed match');
      }
      const rules: FormatRules = match.rules_snapshot;
      if (!rules?.super_over?.enabled) throw new BadRequestException('Super over is not enabled in this format');

      const played = (
        await client.query(`SELECT count(*)::int AS n FROM matches WHERE parent_match_id = $1`, [matchId])
      ).rows[0].n;
      const maxRepeats = rules.super_over.max_repeats ?? 1;
      if (played >= maxRepeats) {
        throw new BadRequestException(`Maximum ${maxRepeats} super over(s) already played — result stands as a tie`);
      }

      const bpo = rules.balls_per_over ?? 6;
      const soBalls = rules.super_over.balls ?? 6;
      const soRules: FormatRules = {
        ...rules,
        innings_per_side: 1,
        overs_per_innings: Math.max(1, Math.round(soBalls / bpo)),
        max_overs_per_bowler: 1,
        wickets_to_fall: 2,
        powerplays: [],
        dls: { enabled: false },
        follow_on: { enabled: false },
        declaration_allowed: false,
      };

      const row = (
        await client.query(
          `INSERT INTO matches (tournament_id, organization_id, stage, stage_label, team_a_id, team_b_id,
                                venue_id, scheduled_start, status, is_super_over, parent_match_id, rules_snapshot)
           VALUES (NULL, $1, 'custom', $2, $3, $4, $5, now(), 'scheduled', true, $6, $7)
           RETURNING id, stage_label, status, team_a_id, team_b_id, parent_match_id`,
          [match.organization_id, played > 0 ? `Super Over ${played + 1}` : 'Super Over',
           match.team_a_id, match.team_b_id, match.venue_id, matchId, JSON.stringify(soRules)],
        )
      ).rows[0];
      return row;
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'super_over_created', child_match_id: child.id });
    return child;
  }

  // -------------------------------------------- rain interruptions / DLS
  /** Pause play (rain / bad light / wet outfield). Records the state at stoppage. */
  async startInterruption(matchId: string, dto: { reason: string }) {
    const out = await this.withMatch(matchId, async (client, match) => {
      if (match.status !== 'live') throw new BadRequestException(`Match is not live (status: ${match.status})`);
      const ls = match.live_state;
      const row = (
        await client.query(
          `INSERT INTO match_interruptions (match_id, innings_id, reason, started_at, state_at_stop)
           VALUES ($1, $2, $3, now(), $4) RETURNING id, reason, started_at`,
          [matchId, ls.innings_id, dto.reason, JSON.stringify(ls.summary ?? {})],
        )
      ).rows[0];
      await client.query(`UPDATE matches SET status = 'rain_delay' WHERE id = $1`, [matchId]);
      return { interruption: row, status: 'rain_delay' };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'interruption_started' });
    return out;
  }

  /**
   * Resume play. Optionally apply a rain revision (DLS or any agreed method):
   * revised_max_overs shrinks the innings; revised_target replaces the chase target.
   * The revision is recorded in matches.dls_info for the scorecard.
   */
  async resumeInterruption(
    matchId: string,
    dto: { overs_lost?: number; revised_max_overs?: number; revised_target?: number; method?: string },
  ) {
    const out = await this.withMatch(matchId, async (client, match) => {
      if (match.status !== 'rain_delay') throw new BadRequestException(`No interruption in progress (status: ${match.status})`);
      const ls = match.live_state;
      const rules: FormatRules = match.rules_snapshot;

      await client.query(
        `UPDATE match_interruptions SET ended_at = now(), overs_lost = $2
         WHERE match_id = $1 AND ended_at IS NULL`,
        [matchId, dto.overs_lost ?? null],
      );

      const applyingRevision = dto.revised_max_overs !== undefined || dto.revised_target !== undefined;
      if (applyingRevision && ls.innings_id) {
        if (dto.revised_max_overs !== undefined) {
          const bowled = ls.engine ? Math.floor(ls.engine.legalBalls / (rules.balls_per_over ?? 6)) : 0;
          if (dto.revised_max_overs <= bowled) {
            throw new BadRequestException(`Revised overs (${dto.revised_max_overs}) must exceed overs already bowled (${bowled})`);
          }
          if (rules.dls?.min_overs_per_side && dto.revised_max_overs < rules.dls.min_overs_per_side) {
            throw new BadRequestException(`Format requires at least ${rules.dls.min_overs_per_side} overs per side`);
          }
          await client.query(`UPDATE innings SET max_overs = $2 WHERE id = $1`, [ls.innings_id, dto.revised_max_overs]);
          if (ls.engine) ls.engine.maxOvers = dto.revised_max_overs;
        }
        if (dto.revised_target !== undefined) {
          await client.query(`UPDATE innings SET target_runs = $2 WHERE id = $1`, [ls.innings_id, dto.revised_target]);
          if (ls.engine) ls.engine.target = dto.revised_target;
        }
        const dlsInfo = {
          method: dto.method ?? rules.dls?.method ?? 'manual',
          revised_overs: dto.revised_max_overs ?? null,
          revised_target: dto.revised_target ?? null,
          applied_at_innings: ls.innings_seq,
        };
        await client.query(
          `UPDATE matches SET dls_applied = true, dls_info = coalesce(dls_info, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
          [matchId, JSON.stringify([dlsInfo])],
        );
        ls.dls = dlsInfo;
      }

      ls.summary = ls.innings_id ? await this.buildSummary(client, ls, rules) : ls.summary;
      await client.query(`UPDATE matches SET status = 'live', live_state = $2 WHERE id = $1`, [matchId, JSON.stringify(ls)]);
      return { status: 'live', dls: ls.dls ?? null, state: ls };
    });
    await this.live.syncAndPublish(matchId, 'status', { transition: 'play_resumed' });
    return out;
  }

  // ------------------------------------------------- offline batch sync
  /**
   * Offline scorer sync: applies queued events in order, deduping on
   * client_event_id. Stops at the first conflict so the device can rebase
   * against the returned authoritative state.
   */
  async ballBatch(matchId: string, userId: string, items: any[]) {
    const results: any[] = [];
    for (const item of items) {
      // Dedupe before any liveness/state validation: a re-sent ball whose
      // original application ended the innings (or match) must come back as
      // 'duplicate', not 'conflict', or the offline outbox retries it forever.
      const dup = await this.pool.query(
        `SELECT b.seq FROM balls b JOIN innings i ON i.id = b.innings_id
         WHERE i.match_id = $1 AND b.client_event_id = $2`,
        [matchId, item.client_event_id],
      );
      if (dup.rowCount! > 0) {
        results.push({ client_event_id: item.client_event_id, status: 'duplicate', seq: dup.rows[0].seq });
        continue;
      }
      try {
        const r = await this.ball(matchId, userId, { ...item, expected_seq: undefined });
        results.push({
          client_event_id: item.client_event_id,
          status: r.code === 'DUPLICATE' ? 'duplicate' : 'applied',
          seq: r.seq,
        });
      } catch (err: any) {
        results.push({
          client_event_id: item.client_event_id,
          status: 'conflict',
          error: err.response ?? { message: err.message },
        });
        break;
      }
    }
    return { results, state: await this.live.getState(matchId) };
  }

  /** Finalize: set POM, force result for abandoned matches, (re)build stats. */
  async finalize(matchId: string, dto: { player_of_match_id?: string; result_type?: string; result_summary?: string }) {
    await this.withMatch(matchId, async (client, match) => {
      if (dto.result_type) {
        await client.query(
          `UPDATE matches SET status = CASE WHEN $2 IN ('abandoned','no_result') THEN $2::match_status ELSE 'completed'::match_status END,
                  result_type = $2, result_summary = coalesce($3, result_summary), completed_at = coalesce(completed_at, now())
           WHERE id = $1`,
          [matchId, dto.result_type, dto.result_summary ?? null],
        );
      }
      if (dto.player_of_match_id) {
        await client.query(`UPDATE matches SET player_of_match_id = $2 WHERE id = $1`, [matchId, dto.player_of_match_id]);
      }
    });
    await this.stats.finalizeMatch(matchId);
    await this.live.syncAndPublish(matchId, 'status', { transition: 'finalized' });
    await this.live.expireMatch(matchId);
    return { finalized: true };
  }

  // ================= internals =================

  private async completeInnings(client: PoolClient, match: any, ls: any, rules: FormatRules, reason: string) {
    const status = reason === 'declared' ? 'declared' : reason === 'forfeited' ? 'forfeited' : 'completed';
    await client.query(
      `UPDATE innings SET status = $2, ended_at = now() WHERE id = $1`,
      [ls.innings_id, status],
    );

    // ---- Innings summary commentary (sorts above the over summary's +1ms nudge) ----
    await client.query(
      `INSERT INTO commentary_entries (match_id, innings_id, source, body, is_highlight, created_at)
       VALUES ($1, $2, 'auto', $3, true, now() + interval '2 milliseconds')`,
      [match.id, ls.innings_id,
       await this.inningsSummaryBody(client, ls.innings_id, ls.innings_seq, rules, reason)],
    );
    const totalInnings = (rules.innings_per_side ?? 1) * 2;
    if (ls.innings_seq >= totalInnings) return; // match end handled by match_complete effect

    const done = (
      await client.query(
        `SELECT i.seq, i.batting_team_id, i.total_runs FROM innings i WHERE i.match_id = $1 ORDER BY i.seq`,
        [match.id],
      )
    ).rows;

    // Follow-on decision point (Tests): after the 2nd innings, if the side that
    // batted first leads by at least the configured deficit, pause for the call.
    if ((rules.innings_per_side ?? 1) === 2 && ls.innings_seq === 2 && rules.follow_on?.enabled) {
      const lead = done[0].total_runs - done[1].total_runs;
      const deficit = rules.follow_on.deficit ?? 200;
      if (lead >= deficit) {
        ls.follow_on_available = { lead, deficit, decision_team_id: done[0].batting_team_id };
        ls.innings_id = null; ls.engine = null;
        ls.batters = {}; ls.bowlers = {}; ls.this_over = [];
        ls.pending_new_batter = null; ls.current_bowler = null;
        await client.query(`UPDATE matches SET status = 'innings_break' WHERE id = $1`, [match.id]);
        match.status = 'innings_break';
        return; // POST /matches/:id/follow-on resumes the match
      }
    }

    await this.createNextInnings(client, match, ls, rules, done, false);
  }

  /**
   * Dynamic innings sequencing: each side bats innings_per_side times; the next
   * batting team is whichever has batted fewer completed innings (ties broken by
   * alternation). A follow-on innings repeats the previous batting team.
   */
  private async createNextInnings(
    client: PoolClient, match: any, ls: any, rules: FormatRules, done: any[], isFollowOn: boolean,
  ) {
    const totalInnings = (rules.innings_per_side ?? 1) * 2;
    const nextSeq = done.length + 1;
    const firstBatting = done[0].batting_team_id;
    const other = firstBatting === match.team_a_id ? match.team_b_id : match.team_a_id;

    let nextBatting: string;
    if (isFollowOn) {
      nextBatting = done[done.length - 1].batting_team_id; // same side bats again
    } else {
      const battedCount = (team: string) => done.filter((i) => i.batting_team_id === team).length;
      const [a, b] = [battedCount(firstBatting), battedCount(other)];
      nextBatting = a < b ? firstBatting
        : b < a ? other
        : done[done.length - 1].batting_team_id === firstBatting ? other : firstBatting;
    }
    const nextBowling = nextBatting === match.team_a_id ? match.team_b_id : match.team_a_id;

    // Target only in the final innings: opponent aggregate − own aggregate + 1
    let target: number | null = null;
    if (nextSeq === totalInnings) {
      const oppRuns = done.filter((i: any) => i.batting_team_id !== nextBatting).reduce((s: number, i: any) => s + i.total_runs, 0);
      const ownRuns = done.filter((i: any) => i.batting_team_id === nextBatting).reduce((s: number, i: any) => s + i.total_runs, 0);
      target = oppRuns - ownRuns + 1;

      // Innings victory: the side due to bat already leads — no final innings needed.
      if (target <= 0) {
        const marginRuns = 1 - target; // own − opp
        await this.completeMatchInningsVictory(client, match, ls, nextBatting, marginRuns);
        return;
      }
    }

    const next = (
      await client.query(
        `INSERT INTO innings (match_id, seq, batting_team_id, bowling_team_id, status, max_overs, target_runs, is_follow_on)
         VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7) RETURNING id`,
        [match.id, nextSeq, nextBatting, nextBowling, rules.overs_per_innings, target, isFollowOn],
      )
    ).rows[0];

    ls.innings_id = next.id;
    ls.innings_seq = nextSeq;
    ls.engine = null;
    ls.batters = {}; ls.bowlers = {}; ls.this_over = []; ls.over_bowler_runs = 0;
    ls.pending_new_batter = null; ls.current_bowler = null;
    await client.query(`UPDATE matches SET status = 'innings_break' WHERE id = $1`, [match.id]);
    match.status = 'innings_break';
  }

  private async completeMatchInningsVictory(
    client: PoolClient, match: any, ls: any, winnerTeamId: string, marginRuns: number,
  ) {
    const winShort = (await client.query(`SELECT short_name FROM teams WHERE id = $1`, [winnerTeamId])).rows[0].short_name;
    const summary = `${winShort} won by an innings and ${marginRuns} run${marginRuns === 1 ? '' : 's'}`;
    await client.query(
      `UPDATE matches SET status = 'completed', completed_at = now(), winner_team_id = $2,
              result_type = 'win', win_margin = $3, result_summary = $4 WHERE id = $1`,
      [match.id, winnerTeamId, JSON.stringify({ by: 'innings', value: marginRuns }), summary],
    );
    match.status = 'completed';
    ls.result_summary = summary;
    ls.innings_id = null; ls.engine = null;
    setImmediate(() => this.stats.finalizeMatch(match.id).catch((e) => console.error('stats finalize failed:', e.message)));
  }

  private async completeMatch(
    client: PoolClient, match: any, ls: any, rules: FormatRules, effect: SideEffect | ForfeitEffect,
  ) {
    const innings = (
      await client.query(
        `SELECT i.*, tm.short_name FROM innings i JOIN teams tm ON tm.id = i.batting_team_id
         WHERE i.match_id = $1 ORDER BY i.seq`,
        [match.id],
      )
    ).rows;
    const last = innings[innings.length - 1];
    let winner: string | null = null;
    let resultType = 'win';
    let margin: any = null;
    let summary = '';

    if (effect.kind === 'innings_forfeited') {
      // Forfeiting hands the match to the other side outright — no margin in
      // runs or wickets exists to quote, and the score is deliberately not
      // consulted (a forfeit at a level score is still a defeat, not a tie).
      winner = last.bowling_team_id;
      resultType = 'forfeit';
      margin = { by: 'forfeit' };
      const winShort = (
        await client.query(`SELECT short_name FROM teams WHERE id = $1`, [winner])
      ).rows[0].short_name;
      summary = `${winShort} won by forfeit`;
    } else if (effect.kind === 'super_over_required' || (effect.kind === 'match_complete' && effect.result === 'tie')) {
      resultType = 'tie';
      summary = 'Match tied';
    } else {
      const chaseTotal = ls.engine.totalRuns;
      const target = ls.engine.target;
      if (target !== null && chaseTotal >= target) {
        winner = last.batting_team_id;
        const wicketsLeft = (rules.wickets_to_fall ?? 10) - ls.engine.totalWickets;
        const ballsLeft = ls.engine.maxOvers !== null ? ls.engine.maxOvers * rules.balls_per_over - ls.engine.legalBalls : null;
        margin = { by: 'wickets', value: wicketsLeft, balls_remaining: ballsLeft };
        summary = `${last.short_name} won by ${wicketsLeft} wicket${wicketsLeft === 1 ? '' : 's'}`;
      } else if (target !== null) {
        winner = last.bowling_team_id;
        const runs = target - 1 - chaseTotal;
        const winShort = (
          await client.query(`SELECT short_name FROM teams WHERE id = $1`, [winner])
        ).rows[0].short_name;
        margin = { by: 'runs', value: runs };
        summary = `${winShort} won by ${runs} run${runs === 1 ? '' : 's'}`;
      }
    }

    await client.query(
      `UPDATE innings SET status = 'completed', ended_at = coalesce(ended_at, now()) WHERE id = $1 AND status = 'in_progress'`,
      [ls.innings_id],
    );
    await client.query(
      `UPDATE matches SET status = 'completed', completed_at = now(), winner_team_id = $2,
              result_type = $3, win_margin = $4, result_summary = $5
       WHERE id = $1`,
      [match.id, winner, resultType, margin ? JSON.stringify(margin) : null, summary],
    );
    match.status = 'completed';
    ls.result_summary = summary;

    // Super-over child: write the decisive result back onto the tied parent.
    if (match.is_super_over && match.parent_match_id && winner) {
      const winShort = (await client.query(`SELECT short_name FROM teams WHERE id = $1`, [winner])).rows[0].short_name;
      await client.query(
        `UPDATE matches SET winner_team_id = $2, result_type = 'win',
                win_margin = '{"by":"super_over"}', result_summary = $3
         WHERE id = $1`,
        [match.parent_match_id, winner, `${winShort} won the Super Over (${match.stage_label ?? 'Super Over'})`],
      );
    }
  }

  /** Rebuild innings counters, over summaries, and live state from the ball stream. */
  private async replayInnings(client: PoolClient, match: any, inningsId: string) {
    const rules: FormatRules = match.rules_snapshot;
    const innings = (await client.query(`SELECT * FROM innings WHERE id = $1`, [inningsId])).rows[0];
    const balls = (
      await client.query(
        `SELECT * FROM balls WHERE innings_id = $1 AND NOT is_superseded ORDER BY seq`,
        [inningsId],
      )
    ).rows;

    const ls = match.live_state;
    // Replaying an innings the match has already moved past (correcting a ball
    // in innings 1 after innings 2 started, or after the match finished) must
    // rebuild that innings' stored data WITHOUT touching live_state or the
    // match status — otherwise a completed match flips back to 'live' and the
    // live panel starts showing the old innings.
    const isCurrent = ls?.innings_id === inningsId;
    let engine: LiveInningsState | null = null;
    const batters: Record<string, any> = {};
    const bowlers: Record<string, any> = {};
    let thisOver: string[] = [];
    let currentBowler: string | null = null;

    await client.query(`DELETE FROM over_summaries WHERE innings_id = $1`, [inningsId]);

    // Auto commentary is derived data: commentaryText() bakes the running score
    // into each body, so every ball from an edited one onward goes stale, and
    // the end-of-over summary shares its ball_id with the ball that closed the
    // over (so a naive delete-by-ball_id wipes the summary entirely). Rebuild
    // the whole innings' auto feed from the replay, reusing the original
    // created_at values so entries keep their place in the feed.
    const priorAuto = (
      await client.query(
        `SELECT ball_id, body, created_at FROM commentary_entries
         WHERE innings_id = $1 AND source = 'auto' AND ball_id IS NOT NULL`,
        [inningsId],
      )
    ).rows;
    const ballTs = new Map<string, Date>();
    const overTs = new Map<string, Date>();
    for (const row of priorAuto) {
      const bucket = String(row.body).startsWith('End of over ') ? overTs : ballTs;
      bucket.set(row.ball_id, row.created_at);
    }
    // A corrected ball is a new row, so inherit the timestamp of the ball it
    // supersedes; the value carries forward across repeated edits.
    const tsFor = (map: Map<string, Date>, b: any): Date | null =>
      map.get(b.id) ?? (b.supersedes_ball_id ? map.get(b.supersedes_ball_id) ?? null : null);
    await client.query(
      `DELETE FROM commentary_entries WHERE innings_id = $1 AND source = 'auto' AND ball_id IS NOT NULL`,
      [inningsId],
    );

    if (balls.length > 0) {
      const first = balls[0];
      engine = {
        seq: first.seq - 1, totalRuns: 0, totalWickets: 0, legalBalls: 0,
        maxOvers: innings.max_overs !== null ? Number(innings.max_overs) : null,
        target: innings.target_runs, freeHitPending: false, currentOverBalls: 0,
        lastOverBowlerId: null, bowlerLegalBalls: {},
        strikerId: first.striker_id, nonStrikerId: first.non_striker_id, battersRetiredHurt: [],
        // Rebuilt ball-by-ball below, exactly like bowlerLegalBalls — never
        // decremented in place, or undo would leave a batter's quota adrift.
        batterLegalBalls: {}, battersCompleted: [],
      };

      // Rotation mode: a voluntary retirement or a withdrawal is NOT a delivery,
      // so it leaves no trace in the ball stream and a pure replay would hand
      // those batters their innings back. rotation_slots is the durable record
      // of those two reasons, so seed from it before replaying.
      if (rules.solo_batting?.enabled) {
        const offBook = await client.query(
          `SELECT player_id FROM rotation_slots
            WHERE match_id = $1 AND ended_reason IN ('voluntary','withdrawn')
            ORDER BY bat_order`,
          [match.id],
        );
        engine.battersCompleted = offBook.rows.map((r: any) => r.player_id);
      }
      for (const b of balls) {
        // Trust recorded striker/bowler (corrections may have changed rotation)
        engine.strikerId = b.striker_id;
        engine.nonStrikerId = b.non_striker_id;
        const autoPenalty = b.extra_type === 'wide' ? rules.wide?.runs ?? 1 : b.extra_type === 'no_ball' ? rules.no_ball?.runs ?? 1 : 0;
        const ev: BallEvent = {
          strikerId: b.striker_id, nonStrikerId: b.non_striker_id, bowlerId: b.bowler_id,
          runsBatter: b.runs_batter, extraType: b.extra_type,
          runsExtras: b.runs_extras - autoPenalty,
          secondaryExtraType: b.secondary_extra_type ?? null,
          wicket: b.is_wicket ? { type: b.wicket_type, dismissedPlayerId: b.dismissed_player_id, fielderId: b.fielder_id, wicketBrokenEnd: b.wicket_broken_end } : null,
        };
        const r = applyBall(engine, ev, rules);
        if (r.ok) engine = r.next;

        // Rebuild cards
        const bat = (batters[b.striker_id] ??= await this.batterCard(client, b.striker_id));
        if (b.extra_type !== 'wide') bat.balls += 1;
        bat.runs += b.runs_batter;
        if (b.is_boundary_four) bat.fours += 1;
        if (b.is_boundary_six) bat.sixes += 1;
        if (b.is_wicket && b.dismissed_player_id) {
          (batters[b.dismissed_player_id] ??= await this.batterCard(client, b.dismissed_player_id)).out = true;
        }
        // Byes/leg-byes (including any run off a no-ball) are never charged to the bowler.
        const bowlerRuns = b.runs_batter
          + (['wide', 'no_ball'].includes(b.extra_type ?? '') ? b.runs_extras - b.secondary_extra_runs : 0);
        const bowl = (bowlers[b.bowler_id] ??= await this.bowlerCard(client, b.bowler_id));
        if (b.is_legal) bowl.legal_balls += 1;
        bowl.runs += bowlerRuns;
        if (b.is_wicket && !['run_out', 'retired_hurt', 'retired_out', 'obstructing_field', 'timed_out'].includes(b.wicket_type)) {
          bowl.wickets += 1;
        }
        await client.query(
          `INSERT INTO over_summaries (innings_id, over_number, bowler_id, runs, wickets, extras, cumulative_runs, cumulative_wickets)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (innings_id, over_number) DO UPDATE SET
             runs = over_summaries.runs + excluded.runs, wickets = over_summaries.wickets + excluded.wickets,
             extras = over_summaries.extras + excluded.extras,
             cumulative_runs = excluded.cumulative_runs, cumulative_wickets = excluded.cumulative_wickets`,
          [inningsId, b.over_number, b.bowler_id, b.runs_batter + b.runs_extras, b.is_wicket ? 1 : 0,
           b.runs_extras, engine.totalRuns, engine.totalWickets],
        );
        currentBowler = b.bowler_id;

        // ---- Ball-by-ball commentary, regenerated against the replayed score ----
        const replayWicketNames = b.is_wicket
          ? {
              dismissed: await this.playerName(client, b.dismissed_player_id),
              fielder: await this.playerName(client, b.fielder_id),
            }
          : {};
        await client.query(
          `INSERT INTO commentary_entries (match_id, innings_id, ball_id, source, body, is_highlight, created_at)
           VALUES ($1,$2,$3,'auto',$4,$5,coalesce($6::timestamptz, now()))`,
          [match.id, inningsId, b.id,
           this.commentaryText(b.over_number, b.ball_in_over, bowl.name, bat.name, ev,
             b.runs_extras, b.is_boundary_four, b.is_boundary_six, engine, b.wagon?.region ?? null,
             replayWicketNames),
           b.is_wicket || b.is_boundary_four || b.is_boundary_six,
           tsFor(ballTs, b)],
        );

        // ---- End-of-over summary (mirrors scoreBall's over_complete effect) ----
        if (r.ok && r.effects.some((e) => e.kind === 'over_complete')) {
          const overAgg = (
            await client.query(
              `SELECT coalesce(sum(runs_batter + CASE WHEN extra_type IN ('wide','no_ball')
                       THEN runs_extras - secondary_extra_runs ELSE 0 END), 0)::int AS runs,
                      coalesce(sum(runs_batter + runs_extras), 0)::int AS total_over_runs,
                      count(*) FILTER (WHERE is_wicket AND wicket_type NOT IN
                        ('run_out','retired_hurt','retired_out','obstructing_field','timed_out'))::int AS bowler_wickets,
                      count(*) FILTER (WHERE is_wicket)::int AS wickets_in_over
               FROM balls WHERE innings_id = $1 AND over_number = $2 AND NOT is_superseded`,
              [inningsId, b.over_number],
            )
          ).rows[0];
          const isMaidenOver = overAgg.runs === 0;
          const isWicketMaiden = isMaidenOver && overAgg.bowler_wickets > 0;
          const overWickets = overAgg.wickets_in_over as number;
          await client.query(
            `UPDATE over_summaries SET is_maiden = $3 WHERE innings_id = $1 AND over_number = $2`,
            [inningsId, b.over_number, isMaidenOver],
          );
          if (isMaidenOver) bowl.maidens += 1;
          thisOver = [];

          const strikerCard = (batters[engine.strikerId] ??= await this.batterCard(client, engine.strikerId));
          const nonStrikerCard = (batters[engine.nonStrikerId] ??= await this.batterCard(client, engine.nonStrikerId));
          const bpo = rules.balls_per_over ?? 6;
          const bowlerFigures = `${Math.floor(bowl.legal_balls / bpo)}.${bowl.legal_balls % bpo}-${bowl.maidens}-${bowl.runs}-${bowl.wickets}`;
          const ballTsForOver = tsFor(ballTs, b);
          await client.query(
            // +1ms keeps the summary above the ball that closed the over, matching scoreBall
            `INSERT INTO commentary_entries (match_id, innings_id, ball_id, source, body, is_highlight, created_at)
             VALUES ($1,$2,$3,'auto',$4,$5,
                     coalesce($6::timestamptz, $7::timestamptz + interval '1 millisecond',
                              now() + interval '1 millisecond'))`,
            [match.id, inningsId, b.id,
             `End of over ${b.over_number + 1} — ${overAgg.total_over_runs} runs: ${engine.totalRuns}/${engine.totalWickets}. ` +
               (isWicketMaiden ? 'WICKET MAIDEN! '
                 : isMaidenOver ? 'Maiden over! '
                 : overWickets > 0 ? `${overWickets} WICKET${overWickets > 1 ? 'S' : ''}! ` : '') +
               `${creaseLine(strikerCard, nonStrikerCard, engine.strikerId === engine.nonStrikerId)}. ` +
               `${bowl.name} ${bowlerFigures}`,
             isMaidenOver || overWickets > 0,
             tsFor(overTs, b), ballTsForOver],
          );
        }
      }
      // this_over = balls of the current (possibly partial) over.
      // Stored runs_extras includes the automatic wide/no-ball penalty, but
      // ballLabel expects only the runs beyond it (a plain wide must render
      // 'wd', not '2wd'), so strip the penalty back out before labelling.
      const currentOver = Math.floor(engine.legalBalls / rules.balls_per_over);
      thisOver = balls
        .filter((b) => b.over_number === currentOver)
        .map((b) => {
          const autoPenalty = b.extra_type === 'wide' ? rules.wide?.runs ?? 1
            : b.extra_type === 'no_ball' ? rules.no_ball?.runs ?? 1 : 0;
          return this.ballLabel(
            {
              runsBatter: b.runs_batter, extraType: b.extra_type, runsExtras: b.runs_extras - autoPenalty,
              secondaryExtraType: b.secondary_extra_type ?? null, wicket: b.is_wicket ? ({} as any) : null,
            } as any,
            b.is_boundary_four, b.is_boundary_six,
          );
        });

      // Maidens: completed overs (everything before the current, possibly
      // partial, over) where the bowler's charged runs (excluding
      // byes/leg-byes, including any run off a no-ball) totalled zero.
      const maidensByBowler = (
        await client.query(
          `SELECT bowler_id, count(*)::int AS maidens FROM (
             SELECT bowler_id, over_number,
                    sum(runs_batter + CASE WHEN extra_type IN ('wide','no_ball')
                        THEN runs_extras - secondary_extra_runs ELSE 0 END) AS runs
             FROM balls
             WHERE innings_id = $1 AND NOT is_superseded AND over_number < $2
             GROUP BY bowler_id, over_number
           ) per_over
           WHERE runs = 0
           GROUP BY bowler_id`,
          [inningsId, currentOver],
        )
      ).rows;
      for (const row of maidensByBowler) {
        (bowlers[row.bowler_id] ??= await this.bowlerCard(client, row.bowler_id)).maidens = row.maidens;
      }
    }

    // Recompute innings counters from balls
    const agg = (
      await client.query(
        `SELECT coalesce(sum(runs_batter + runs_extras),0)::int AS runs,
                count(*) FILTER (WHERE is_wicket AND wicket_type <> 'retired_hurt')::int AS wkts,
                count(*) FILTER (WHERE is_legal)::int AS legal,
                coalesce(sum(runs_extras) FILTER (WHERE extra_type = 'wide'),0)::int AS wides,
                coalesce(sum(runs_extras - secondary_extra_runs) FILTER (WHERE extra_type = 'no_ball'),0)::int AS nbs,
                coalesce(sum(runs_extras) FILTER (WHERE extra_type = 'bye'),0)::int
                  + coalesce(sum(secondary_extra_runs) FILTER (WHERE secondary_extra_type = 'bye'),0)::int AS byes,
                coalesce(sum(runs_extras) FILTER (WHERE extra_type = 'leg_bye'),0)::int
                  + coalesce(sum(secondary_extra_runs) FILTER (WHERE secondary_extra_type = 'leg_bye'),0)::int AS lbs
         FROM balls WHERE innings_id = $1 AND NOT is_superseded`,
        [inningsId],
      )
    ).rows[0];
    await client.query(
      `UPDATE innings SET total_runs=$2, total_wickets=$3, legal_balls=$4,
              extras_wides=$5, extras_no_balls=$6, extras_byes=$7, extras_leg_byes=$8 WHERE id=$1`,
      [inningsId, agg.runs, agg.wkts, agg.legal, agg.wides, agg.nbs, agg.byes, agg.lbs],
    );

    // Rotation mode: rotation_slots and rotation_bowl_quota are incremented in
    // place per ball, so an undo leaves them holding the pre-undo totals — and
    // the console's ranking table reads them, not ls.batters. Recompute both
    // from the surviving stream, and drop a 'dismissed'/'quota' close whose
    // ball no longer exists ('voluntary'/'withdrawn' leave no ball, so they
    // are the durable record replay seeds from and must survive untouched).
    if (rules.solo_batting?.enabled) {
      await client.query(
        `UPDATE rotation_slots s
            SET balls_faced = agg.legal, runs_scored = agg.runs
           FROM (SELECT r.player_id,
                        count(b.id) FILTER (WHERE b.is_legal)::int AS legal,
                        coalesce(sum(b.runs_batter), 0)::int AS runs
                   FROM rotation_slots r
                   LEFT JOIN balls b ON b.striker_id = r.player_id
                                    AND b.innings_id = $2 AND NOT b.is_superseded
                  WHERE r.match_id = $1
                  GROUP BY r.player_id) agg
          WHERE s.match_id = $1 AND s.player_id = agg.player_id`,
        [match.id, inningsId],
      );
      await client.query(
        `UPDATE rotation_bowl_quota q
            SET legal_balls = agg.legal, last_over_number = agg.last_over
           FROM (SELECT r.player_id,
                        count(b.id) FILTER (WHERE b.is_legal)::int AS legal,
                        max(b.over_number) AS last_over
                   FROM rotation_bowl_quota r
                   LEFT JOIN balls b ON b.bowler_id = r.player_id
                                    AND b.innings_id = $2 AND NOT b.is_superseded
                  WHERE r.match_id = $1
                  GROUP BY r.player_id) agg
          WHERE q.match_id = $1 AND q.player_id = agg.player_id`,
        [match.id, inningsId],
      );
      await client.query(
        `UPDATE rotation_slots SET ended_reason = NULL, ended_at = NULL
          WHERE match_id = $1 AND ended_reason IN ('dismissed', 'quota')
            AND player_id <> ALL($2::uuid[])`,
        [match.id, engine?.battersCompleted ?? []],
      );
    }

    // The end-of-innings card is auto commentary too, but it hangs off the
    // innings rather than a ball (ball_id IS NULL), so the ball-keyed rebuild
    // above skips it — regenerate it here or it keeps quoting the score from
    // before the correction. Must run after the totals update just above.
    if (['completed', 'declared', 'forfeited'].includes(innings.status)) {
      // Reuse the existing card's timestamp. Innings scored before this card
      // existed have none, so fall back to just after the innings' last ball
      // rather than now() — otherwise the card lands at today's date and sorts
      // to the top of the feed instead of at the end of its innings.
      const prevTs = (
        await client.query(
          `SELECT coalesce(
                    (SELECT created_at FROM commentary_entries
                      WHERE innings_id = $1 AND source = 'auto' AND ball_id IS NULL
                      ORDER BY created_at LIMIT 1),
                    (SELECT max(created_at) + interval '2 milliseconds' FROM commentary_entries
                      WHERE innings_id = $1 AND source = 'auto' AND ball_id IS NOT NULL)
                  ) AS ts`,
          [inningsId],
        )
      ).rows[0]?.ts ?? null;
      await client.query(
        `DELETE FROM commentary_entries WHERE innings_id = $1 AND source = 'auto' AND ball_id IS NULL`,
        [inningsId],
      );
      await client.query(
        `INSERT INTO commentary_entries (match_id, innings_id, source, body, is_highlight, created_at)
         VALUES ($1,$2,'auto',$3,true,
                 coalesce($4::timestamptz, now() + interval '2 milliseconds'))`,
        [match.id, inningsId,
         await this.inningsSummaryBody(client, inningsId, innings.seq, rules, innings.status),
         prevTs],
      );
    }

    // This innings' total feeds the chase target of the innings that follows
    // (target = opponent aggregate − own aggregate + 1), so a correction here
    // has to move that target too — otherwise the run chase keeps showing the
    // number derived from the pre-edit score.
    const allInnings = (
      await client.query(
        `SELECT id, seq, batting_team_id, total_runs, target_runs FROM innings
         WHERE match_id = $1 ORDER BY seq`,
        [match.id],
      )
    ).rows;
    const replayed = allInnings.find((i) => i.id === inningsId);
    for (const later of allInnings) {
      if (!replayed || later.seq <= replayed.seq || later.target_runs === null) continue;
      const prior = allInnings.filter((i) => i.seq < later.seq);
      const sumFor = (own: boolean) => prior
        .filter((i) => (i.batting_team_id === later.batting_team_id) === own)
        .reduce((s, i) => s + Number(i.total_runs), 0);
      const target = sumFor(false) - sumFor(true) + 1;
      if (target !== later.target_runs) {
        await client.query(`UPDATE innings SET target_runs = $2 WHERE id = $1`, [later.id, target]);
        if (ls?.innings_id === later.id && ls.engine) ls.engine.target = target;
      }
    }

    // Only the live innings owns live_state / match status (see isCurrent).
    if (!isCurrent) return ls;

    ls.batters = batters;
    ls.bowlers = bowlers;
    ls.this_over = thisOver;
    ls.over_bowler_runs = 0;
    ls.pending_new_batter = null;
    ls.current_bowler = currentBowler;
    ls.engine = engine;
    if (rules.solo_batting?.enabled) {
      ls.rotation = await this.rotation.buildBlock(client, match.id, rules, engine);
    }
    ls.summary = await this.buildSummary(client, ls, rules);
    const newSeq = engine?.seq ?? 0;
    // No balls survived the replay (e.g. the innings was closed before any ball
    // was scored) — there is no striker/bowler to resume with, so drop back to
    // innings_break instead of a broken 'live' state; openers() will accept a
    // fresh selection from there.
    // When replaying the current innings, allow status transitions even if the
    // match was previously completed: a ball edit that changes the innings outcome
    // should revert the match from 'completed' to 'live' or 'innings_break'.
    const newStatus = engine ? 'live' : 'innings_break';
    await client.query(
      `UPDATE matches SET live_state = $2, live_state_seq = $3, status = $4 WHERE id = $1`,
      [match.id, JSON.stringify(ls), newSeq, newStatus],
    );
    return ls;
  }

  // ---- helpers ----

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

  private async assertInXI(client: PoolClient, matchId: string, playerIds: string[], need: 'bat' | 'bowl') {
    for (const id of playerIds) {
      const r = await client.query(
        `SELECT 1 FROM match_players
         WHERE match_id = $1 AND player_id = $2
           AND (is_playing_xi OR (is_twelfth AND ${need === 'bat' ? 'can_bat' : 'can_bowl'}))`,
        [matchId, id],
      );
      if (r.rowCount === 0) {
        // Allow when no squad was registered (casual scoring)
        const anySquad = await client.query(`SELECT 1 FROM match_players WHERE match_id = $1 LIMIT 1`, [matchId]);
        if (anySquad.rowCount! > 0) throw new BadRequestException(`Player ${id} is not eligible to ${need} in this match`);
      }
    }
  }

  private async batterCard(client: PoolClient, playerId: string) {
    const p = (await client.query(`SELECT full_name FROM players WHERE id = $1`, [playerId])).rows[0];
    return { name: p?.full_name ?? 'Unknown', runs: 0, balls: 0, fours: 0, sixes: 0, out: false };
  }

  private async bowlerCard(client: PoolClient, playerId: string) {
    const p = (await client.query(`SELECT full_name FROM players WHERE id = $1`, [playerId])).rows[0];
    return { name: p?.full_name ?? 'Unknown', legal_balls: 0, runs: 0, wickets: 0, maidens: 0 };
  }

  /**
   * Name for a player id, for the wicket commentary. Neither participant it
   * resolves is reachable from the live cards: a run out can dismiss the
   * non-striker (who has no batter card until they face a ball) and the
   * fielder is on the other side entirely. Only called on wicket balls, so it
   * costs at most two queries per dismissal.
   */
  private async playerName(client: PoolClient, playerId?: string | null): Promise<string | null> {
    if (!playerId) return null;
    const p = (await client.query(`SELECT full_name FROM players WHERE id = $1`, [playerId])).rows[0];
    return p?.full_name ?? null;
  }

  /**
   * Body of the end-of-innings summary card. Derived entirely from stored balls
   * and innings totals, so replayInnings can rebuild it verbatim after a
   * correction — `reason` also accepts the innings' own status ('declared' /
   * 'forfeited' / 'completed'), which is what the replay path passes.
   */
  private async inningsSummaryBody(
    client: PoolClient, inningsId: string, inningsSeq: number,
    rules: FormatRules, reason: string,
  ): Promise<string> {
    const inn = (
      await client.query(
        `SELECT i.total_runs, i.total_wickets, i.legal_balls, t.name AS team_name
         FROM innings i JOIN teams t ON t.id = i.batting_team_id WHERE i.id = $1`,
        [inningsId],
      )
    ).rows[0];
    const bpoInn = rules.balls_per_over ?? 6;
    const topBatters = (
      await client.query(
        `SELECT p.full_name, sum(b.runs_batter)::int AS runs,
                count(*) FILTER (WHERE b.extra_type IS DISTINCT FROM 'wide')::int AS balls,
                count(*) FILTER (WHERE b.is_boundary_four)::int AS fours,
                count(*) FILTER (WHERE b.is_boundary_six)::int AS sixes
         FROM balls b JOIN players p ON p.id = b.striker_id
         WHERE b.innings_id = $1 AND NOT b.is_superseded
         GROUP BY p.full_name ORDER BY runs DESC, balls ASC LIMIT 2`,
        [inningsId],
      )
    ).rows;
    const topBowlers = (
      await client.query(
        `SELECT p.full_name,
                count(*) FILTER (WHERE b.is_legal)::int AS legal_balls,
                sum(b.runs_batter + CASE WHEN b.extra_type IN ('wide','no_ball')
                     THEN b.runs_extras - b.secondary_extra_runs ELSE 0 END)::int AS runs,
                count(*) FILTER (WHERE b.is_wicket AND b.wicket_type NOT IN
                  ('run_out','retired_hurt','retired_out','obstructing_field','timed_out'))::int AS wickets,
                (SELECT count(*) FROM over_summaries os
                  WHERE os.innings_id = $1 AND os.bowler_id = b.bowler_id AND os.is_maiden)::int AS maidens
         FROM balls b JOIN players p ON p.id = b.bowler_id
         WHERE b.innings_id = $1 AND NOT b.is_superseded
         GROUP BY b.bowler_id, p.full_name ORDER BY wickets DESC, runs ASC LIMIT 2`,
        [inningsId],
      )
    ).rows;
    // " | " section separators keep the body parseable on the client even
    // though player names contain periods ("Md. …").
    const batTxt = topBatters.map((b) => {
      const parts = [`${b.balls}`];
      if (b.sixes > 0) parts.push(`${b.sixes}x6`);
      if (b.fours > 0) parts.push(`${b.fours}x4`);
      return `${b.full_name} ${b.runs}(${parts.join(', ')})`;
    }).join(' · ');
    const bowlTxt = topBowlers.map((b) =>
      `${b.full_name} ${Math.floor(b.legal_balls / bpoInn)}.${b.legal_balls % bpoInn}-${b.maidens}-${b.runs}-${b.wickets}`,
    ).join(' · ');
    return `End of innings ${inningsSeq}: ${inn.team_name} ${inn.total_runs}/${inn.total_wickets} ` +
      `(${Math.floor(inn.legal_balls / bpoInn)}.${inn.legal_balls % bpoInn} ov)` +
      (reason === 'declared' ? ' — declared.' : reason === 'forfeited' ? ' — forfeited.' : '.') +
      (batTxt ? ` | BAT: ${batTxt}` : '') +
      (bowlTxt ? ` | BOWL: ${bowlTxt}` : '');
  }

  /**
   * Dismissal clause for the ball commentary. Two dismissals carry a name the
   * `{bowler} to {striker}` head does not already supply:
   *  - run out: the batter dismissed can be the NON-striker, so naming them is
   *    the only way to tell who actually walked off; the fielder who effected
   *    it is bracketed, matching the scorebook convention dismissalText() uses
   *    on the scorecard ("run out (Jadeja)").
   *  - caught / caught behind: the catch belongs to a fielder nobody has named
   *    yet. Caught & bowled takes no "by" name — there the catcher is the
   *    bowler, who the head already names.
   * Every name is optional (fielder_id is nullable on a run out — the throw
   * often can't be attributed), so each arm degrades to the bare wording.
   */
  private wicketClause(
    ev: BallEvent & { wicket: NonNullable<BallEvent['wicket']> },
    dismissed: string | null, fielder: string | null,
  ): string {
    const w = ev.wicket;
    const plain = w.type.replace(/_/g, ' ');
    switch (w.type) {
      case 'run_out':
        return `${dismissed ? `${dismissed} ` : ''}run out${fielder ? ` (${fielder})` : ''}`;
      case 'caught':
      case 'caught_behind':
        // A bowler holding his own catch is caught & bowled even when it was
        // scored as plain 'caught' — same normalisation the scorecard applies.
        if (w.fielderId && w.fielderId === ev.bowlerId) return 'caught & bowled';
        return `${plain}${fielder ? ` by ${fielder}` : ''}`;
      case 'caught_and_bowled':
        // Spelled the same either way it was scored, so the feed never shows
        // both "caught & bowled" and "caught and bowled" for one dismissal.
        return 'caught & bowled';
      default:
        return plain;
    }
  }

  private commentaryText(
    over: number, ballInOver: number, bowler: string, striker: string,
    ev: BallEvent, totalExtras: number, four: boolean, six: boolean, post: LiveInningsState,
    region: string | null = null,
    wicketNames: { dismissed?: string | null; fielder?: string | null } = {},
  ): string {
    const head = `${over}.${ballInOver} — ${bowler} to ${striker}, `;
    // Shot placement from the scorer's wagon tap, e.g. 'mid_wicket' → ' to mid wicket'
    const to = region && ev.extraType !== 'wide' ? ` to ${region.replace(/_/g, ' ')}` : '';
    let desc: string;
    if (ev.wicket) {
      const clause = this.wicketClause(
        ev as BallEvent & { wicket: NonNullable<BallEvent['wicket']> },
        wicketNames.dismissed ?? null, wicketNames.fielder ?? null,
      );
      // Comma, not a second bracket: the run-out clause already ends in one
      // ("run out (Jadeja)"), and "(Jadeja) (2 runs completed)" reads badly.
      desc = `WICKET! ${clause}${ev.runsBatter ? `, ${ev.runsBatter} run${ev.runsBatter > 1 ? 's' : ''} completed` : ''}`;
    } else if (six) desc = `SIX!${region ? ` Launched over ${region.replace(/_/g, ' ')}` : ' That has sailed over the rope'}`;
    else if (four) desc = `FOUR!${region ? ` Finds the ${region.replace(/_/g, ' ')} boundary` : ' Finds the boundary'}`;
    else if (ev.extraType === 'wide') desc = `wide${totalExtras > 1 ? `, ${totalExtras} extras` : ''}`;
    else if (ev.extraType === 'no_ball' && ev.secondaryExtraType) {
      desc = `no ball, ${ev.runsExtras} ${ev.secondaryExtraType === 'bye' ? 'bye' : 'leg bye'}${ev.runsExtras > 1 ? 's' : ''}${post.freeHitPending ? ', free hit coming up' : ''}`;
    }
    else if (ev.extraType === 'no_ball') desc = `no ball${ev.runsBatter ? ` — ${ev.runsBatter} off the bat` : ''}${post.freeHitPending ? ', free hit coming up' : ''}`;
    else if (ev.extraType === 'bye') desc = `${ev.runsExtras} bye${ev.runsExtras > 1 ? 's' : ''}`;
    else if (ev.extraType === 'leg_bye') desc = `${ev.runsExtras} leg bye${ev.runsExtras > 1 ? 's' : ''}`;
    else if (ev.runsBatter === 0) desc = `no run${to}`;
    else desc = `${ev.runsBatter} run${ev.runsBatter > 1 ? 's' : ''}${to}`;
    return `${head}${desc}. ${post.totalRuns}/${post.totalWickets}`;
  }

  private ballLabel(ev: BallEvent, four: boolean, six: boolean): string {
    if (ev.wicket) return ev.runsBatter ? `${ev.runsBatter}W` : 'W';
    if (ev.extraType === 'wide') return `${ev.runsExtras ? ev.runsExtras + 1 : ''}wd`;
    if (ev.extraType === 'no_ball' && ev.secondaryExtraType) return `nb+${ev.runsExtras}${ev.secondaryExtraType === 'bye' ? 'b' : 'lb'}`;
    if (ev.extraType === 'no_ball') return `${ev.runsBatter ? ev.runsBatter : ''}nb`;
    if (ev.extraType === 'bye') return `${ev.runsExtras}b`;
    if (ev.extraType === 'leg_bye') return `${ev.runsExtras}lb`;
    if (six) return '6';
    if (four) return '4';
    return String(ev.runsBatter);
  }

  /**
   * Align the frozen rules with the XI that actually walks out.
   *
   * `wickets_to_fall` decides both when an innings is all out and — via
   * `completeMatch` — the winning margin. Taking it from the format alone
   * breaks whenever the registered squads disagree with it: a 6-a-side game
   * played under a 3-a-side preset reported "won by 1 wicket" when the chasing
   * side finished with 4 in hand, because the margin is (wickets_to_fall −
   * wickets lost) and wickets_to_fall was 2 rather than 5. The squads are the
   * ground truth about how many wickets CAN fall, and by toss time they are
   * known, so this is the right moment to reconcile.
   *
   * Two deliberate guards:
   *  - Only when the format keeps the conventional `wickets_to_fall =
   *    players_per_side − 1`. Presets that decouple them on purpose — a super
   *    over caps wickets at 2 with a full XI — must survive untouched.
   *  - Only when both sides registered the SAME number. Unequal XIs have no
   *    single right answer at match level (one value would either strand the
   *    larger side or end the smaller one early), so the format is left alone
   *    rather than guessed at.
   */
  private async reconcileSquadSize(
    client: PoolClient,
    matchId: string,
    rules: FormatRules,
  ): Promise<FormatRules> {
    // Rotation mode deliberately sets players_per_side = batter_count + 1 and
    // wickets_to_fall = batter_count, which is exactly the shape this helper
    // looks for. Left alone it would rewrite both from the squad counts and
    // re-arm the last-man-standing branch the +1 exists to disable. (It would
    // currently bail out anyway, because it needs two teams of equal size and
    // rotation puts the whole pool on one — but that is luck, not intent.)
    if (rules.solo_batting?.enabled) return rules;
    if (rules.wickets_to_fall !== rules.players_per_side - 1) return rules;

    const counts = (
      await client.query(
        `SELECT team_id, count(*)::int AS n FROM match_players
          WHERE match_id = $1 AND is_playing_xi GROUP BY team_id`,
        [matchId],
      )
    ).rows;

    if (counts.length !== 2) return rules;
    const [a, b] = counts.map((r) => r.n);
    if (a !== b || a < 2 || a === rules.players_per_side) return rules;

    return { ...rules, players_per_side: a, wickets_to_fall: a - 1 };
  }

  private async summaryShell(client: PoolClient, battingTeamId: string, target: number | null) {
    const result = (await client.query(`SELECT short_name FROM teams WHERE id = $1`, [battingTeamId])).rows;
    const t = result?.[0];
    if (!t) throw new BadRequestException(`Team ${battingTeamId} not found`);
    return { batting_team: t.short_name, score: '0/0', overs: '0.0', target, current_rr: 0, required_rr: null };
  }

  private async buildSummary(client: PoolClient, ls: any, rules: FormatRules) {
    const innings = (
      await client.query(
        `SELECT i.total_runs, i.total_wickets, i.legal_balls, i.target_runs, i.max_overs, tm.short_name
         FROM innings i JOIN teams tm ON tm.id = i.batting_team_id WHERE i.id = $1`,
        [ls.innings_id],
      )
    ).rows[0];
    if (!innings) return ls.summary;
    const bpo = rules.balls_per_over ?? 6;
    const overs = `${Math.floor(innings.legal_balls / bpo)}.${innings.legal_balls % bpo}`;
    const crr = innings.legal_balls > 0 ? +(innings.total_runs * bpo / innings.legal_balls).toFixed(2) : 0;
    let rrr: number | null = null;
    if (innings.target_runs !== null && innings.max_overs !== null) {
      const ballsLeft = Number(innings.max_overs) * bpo - innings.legal_balls;
      // Runs still needed floors at 0: once the target is passed the chase is
      // over, and a "required rate" of -2.25 is meaningless. Balls can remain
      // (a chase won with overs to spare), so this survives into the completed
      // match's stored summary unless clamped here.
      const runsNeeded = Math.max(0, innings.target_runs - innings.total_runs);
      rrr = ballsLeft > 0 ? +((runsNeeded * bpo) / ballsLeft).toFixed(2) : null;
    }
    return {
      batting_team: innings.short_name,
      score: `${innings.total_runs}/${innings.total_wickets}`,
      overs,
      target: innings.target_runs,
      current_rr: crr,
      required_rr: rrr,
    };
  }
}
