/**
 * Pure, stateless cricket rules engine.
 * (state, event, rules) -> validated next state + side effects.
 * The same JSON fixture suite runs against this and the Dart port in mobile,
 * so scorer-side validation can never drift from the server.
 */

export interface FormatRules {
  innings_per_side: number;
  overs_per_innings: number | null; // null = unlimited (Test)
  balls_per_over: number;
  players_per_side: number;
  max_overs_per_bowler: number | null;
  wickets_to_fall: number;
  powerplays: Array<{ type: string; from_over: number; to_over: number; max_fielders_outside_circle: number }>;
  super_over: { enabled: boolean; max_repeats?: number; balls?: number };
  dls: { enabled: boolean; method?: string; min_overs_per_side?: number };
  follow_on: { enabled: boolean; deficit?: number | null };
  declaration_allowed: boolean;
  no_ball: { runs: number; free_hit: boolean };
  wide: { runs: number };
  twelfth_man: { allowed: boolean; can_bat?: boolean; can_bowl?: boolean };
  /**
   * Rotation ("gully") mode: one batter at a time, no partner, everyone in the
   * pool bats once. Absent or disabled => ordinary cricket and every branch
   * below is inert, so no existing format changes behaviour.
   *
   * The solo batter is represented by pointing BOTH ends at the same player
   * (strikerId === nonStrikerId), which is the shape the engine already takes
   * during last man standing — so strike rotation and the over-change swap
   * become swaps of a value with itself and need no special-casing.
   *
   * IMPORTANT: `players_per_side` must be set to batter_count + 1. The
   * last-man-standing branch below triggers at `players_per_side - 1` wickets;
   * with players_per_side === batter_count it would fire on the second-to-last
   * batter and silently deny the final batter their innings.
   */
  solo_batting?: {
    enabled: boolean;
    /** Pool size N — the number of batters, and the terminating quantity. */
    batter_count: number;
    /** Legal balls each batter faces before retiring out on quota. */
    balls_per_batter: number;
    retire_on_quota?: boolean;
    /** Allow the batter to also bowl the delivery they are facing. Never true in practice. */
    bowler_may_be_batter?: boolean;
  };
  [key: string]: unknown; // custom tournament keys flow through untouched
}

export interface BallEvent {
  strikerId: string;
  nonStrikerId: string;
  bowlerId: string;
  runsBatter: number;
  extraType: 'wide' | 'no_ball' | 'bye' | 'leg_bye' | 'penalty' | null;
  runsExtras: number;
  /**
   * A no-ball can ALSO carry byes/leg-byes run by the batsmen off it (the
   * no-ball penalty and the byes are scored and charged separately — the
   * penalty stays a no-ball against the bowler, the byes don't). Only
   * meaningful when extraType === 'no_ball'; runsExtras in that case holds
   * the byes/leg-byes run count (the automatic penalty is added on top by
   * the rules, same as a plain no-ball). A wide never gets one of these —
   * runs taken off a wide are, by law, scored entirely as more wides.
   */
  secondaryExtraType?: 'bye' | 'leg_bye' | null;
  wicket: { type: WicketType; dismissedPlayerId: string; fielderId?: string; wicketBrokenEnd?: 'striker_end' | 'non_striker_end' } | null;
}

export type WicketType =
  | 'bowled' | 'caught' | 'caught_behind' | 'caught_and_bowled' | 'lbw' | 'run_out'
  | 'stumped' | 'hit_wicket' | 'retired_hurt' | 'retired_out' | 'obstructing_field'
  | 'timed_out' | 'hit_ball_twice' | 'handled_ball' | 'declared_out';

/** Dismissals still legal on a free hit (only "not off the bowling" modes). */
const FREE_HIT_LEGAL_WICKETS: ReadonlySet<WicketType> = new Set([
  'run_out', 'obstructing_field', 'retired_hurt', 'retired_out', 'handled_ball',
]);

export interface LiveInningsState {
  seq: number;
  totalRuns: number;
  totalWickets: number;
  legalBalls: number;
  maxOvers: number | null;       // effective (rain-reduced) overs, null in Tests
  target: number | null;
  freeHitPending: boolean;
  currentOverBalls: number;      // legal balls so far this over
  lastOverBowlerId: string | null;
  bowlerLegalBalls: Record<string, number>;
  strikerId: string;
  nonStrikerId: string;
  battersRetiredHurt: string[];
  /**
   * Rotation mode only. Legal balls faced per batter — the basis of the
   * per-batter quota, and the mirror image of bowlerLegalBalls. Counts legal
   * deliveries only, so a quota of `overs_per_batter * balls_per_over` really
   * does buy that many overs regardless of how many wides are bowled at them.
   */
  batterLegalBalls: Record<string, number>;
  /**
   * Rotation mode only. Batters whose innings is over, by dismissal OR by
   * exhausting their quota. This — not totalWickets — is what ends a rotation
   * innings: a batter who survives their overs never raises the wicket count,
   * so a wickets-only termination check would never fire in a match where
   * everybody bats out their allotment.
   */
  battersCompleted: string[];
}

export type SideEffect =
  | { kind: 'over_complete'; overNumber: number }
  | { kind: 'innings_complete'; reason: 'all_out' | 'overs' | 'target_reached' | 'declared' | 'all_batted' }
  | { kind: 'match_complete'; result: 'win' | 'tie' }
  | { kind: 'super_over_required' }
  | { kind: 'new_batter_required'; dismissedId: string }
  /** Rotation mode: the batter's allotted overs are used up — not a dismissal. */
  | { kind: 'batter_retired'; playerId: string; reason: 'quota' }
  | { kind: 'free_hit_next' }
  | { kind: 'milestone'; type: 'fifty' | 'hundred' | 'hattrick' | 'five_for'; playerId: string };

export type ValidationResult =
  | { ok: true; next: LiveInningsState; effects: SideEffect[] }
  | { ok: false; code: string; message: string };

export function applyBall(state: LiveInningsState, ev: BallEvent, rules: FormatRules): ValidationResult {
  // ---- Guards -------------------------------------------------------------
  if (ev.strikerId !== state.strikerId) {
    return err('WRONG_STRIKER', 'Striker does not match live state — resync required');
  }

  if (state.currentOverBalls === 0 && ev.bowlerId === state.lastOverBowlerId) {
    return err('CONSECUTIVE_OVERS', 'A bowler cannot bowl consecutive overs');
  }

  // Rotation mode: the pool bats and bowls, so the batter is always also an
  // eligible bowler — and without this guard a scorer can hand them the ball
  // while they are at the crease, which the ball row (striker === bowler)
  // would then happily store.
  if (rules.solo_batting?.enabled && !rules.solo_batting.bowler_may_be_batter
      && ev.bowlerId === state.strikerId) {
    return err('BOWLER_IS_BATTER', 'The batter cannot bowl to themselves — pick another bowler');
  }

  if (rules.max_overs_per_bowler !== null) {
    const bowled = state.bowlerLegalBalls[ev.bowlerId] ?? 0;
    if (bowled >= rules.max_overs_per_bowler * rules.balls_per_over) {
      return err('BOWLER_QUOTA', `Bowler has completed the maximum ${rules.max_overs_per_bowler} overs`);
    }
  }

  if (ev.wicket && state.freeHitPending && !FREE_HIT_LEGAL_WICKETS.has(ev.wicket.type)) {
    return err('FREE_HIT_WICKET', `${ev.wicket.type} is not a legal dismissal on a free hit`);
  }

  const isLegalDelivery = ev.extraType !== 'wide' && ev.extraType !== 'no_ball';

  if (ev.extraType === 'wide' && ev.wicket && !['run_out', 'stumped'].includes(ev.wicket.type)) {
    return err('WIDE_WICKET', 'Only run out or stumped is possible off a wide');
  }

  // ---- Apply --------------------------------------------------------------
  const effects: SideEffect[] = [];
  const next: LiveInningsState = structuredClone(state);
  next.seq = state.seq + 1;

  let extras = ev.runsExtras;
  if (ev.extraType === 'wide') extras += rules.wide.runs;
  if (ev.extraType === 'no_ball') extras += rules.no_ball.runs;

  next.totalRuns += ev.runsBatter + extras;

  if (ev.extraType === 'no_ball' && rules.no_ball.free_hit) {
    next.freeHitPending = true;
    effects.push({ kind: 'free_hit_next' });
  } else if (isLegalDelivery) {
    next.freeHitPending = false;
  }

  if (isLegalDelivery) {
    next.legalBalls += 1;
    next.currentOverBalls += 1;
    next.bowlerLegalBalls[ev.bowlerId] = (next.bowlerLegalBalls[ev.bowlerId] ?? 0) + 1;
    // Rotation mode: the striker's own ball count, for the per-batter quota.
    // Legacy states predate this map, hence the ??= rather than a bare index.
    next.batterLegalBalls ??= {};
    next.batterLegalBalls[ev.strikerId] = (next.batterLegalBalls[ev.strikerId] ?? 0) + 1;
  }
  next.battersCompleted ??= [];

  // Last man standing: no reserve batter left in the squad to send in — only
  // reachable when wickets_to_fall was explicitly raised to players_per_side
  // ("last man batting"). The sole survivor plays on alone at both ends
  // rather than being prompted for a replacement that doesn't exist.
  // retired_hurt is excluded — that's a temporary substitute, not a real
  // dismissal, and doesn't consume the squad's last reserve slot the same way.
  let lastManStanding = false;
  if (ev.wicket) {
    if (ev.wicket.type !== 'retired_hurt') next.totalWickets += 1;
    else next.battersRetiredHurt.push(ev.wicket.dismissedPlayerId);

    // Rotation mode: a dismissal uses up a batter's slot. retired_hurt does
    // not — it is a temporary absence, and the same player can be sent back in.
    if (rules.solo_batting?.enabled && ev.wicket.type !== 'retired_hurt'
        && !next.battersCompleted.includes(ev.wicket.dismissedPlayerId)) {
      next.battersCompleted.push(ev.wicket.dismissedPlayerId);
    }

    const noReserveLeft = ev.wicket.type !== 'retired_hurt'
      && next.totalWickets >= rules.players_per_side - 1;
    lastManStanding = noReserveLeft && next.totalWickets < rules.wickets_to_fall;

    if (lastManStanding) {
      const survivorId = ev.wicket.dismissedPlayerId === state.strikerId ? state.nonStrikerId : state.strikerId;
      next.strikerId = survivorId;
      next.nonStrikerId = survivorId;
    } else {
      effects.push({ kind: 'new_batter_required', dismissedId: ev.wicket.dismissedPlayerId });
    }
  }

  // Strike rotation: use a deterministic matrix for run-outs; normal rotation otherwise.
  //
  // Run-out placement follows one rule: THE INCOMING BATTER ARRIVES AT THE END
  // WHERE THE WICKET FELL, so the survivor necessarily stands at the other end.
  // Completed runs never enter into it — where the two batters physically ended
  // up is already encoded by (dismissedPlayerId, wicketBrokenEnd).
  //
  // The replacement isn't known yet (the scorer picks them after the ball), so
  // the dismissed id is parked in the fallen end's slot as a placeholder;
  // newBatter() swaps that exact slot for the replacement, which drops them on
  // the correct end without needing to re-derive any of this.
  //
  // Last man standing skips this entirely — both ends already point at the
  // sole survivor above, and there's no incoming batter to place.
  if (lastManStanding) {
    // no-op: survivor already occupies both ends
  } else if (ev.wicket?.type === 'run_out' && ev.wicket.wicketBrokenEnd) {
    const dismissedId = ev.wicket.dismissedPlayerId;
    const survivorId = dismissedId === state.strikerId ? state.nonStrikerId : state.strikerId;
    if (ev.wicket.wicketBrokenEnd === 'striker_end') {
      // Wicket fell at the striker's end → replacement comes in there and faces.
      next.strikerId = dismissedId;
      next.nonStrikerId = survivorId;
    } else {
      // Wicket fell at the non-striker's end → replacement comes in there,
      // survivor is left at the striker's end and takes strike.
      next.strikerId = survivorId;
      next.nonStrikerId = dismissedId;
    }
  } else {
    // Non-run-out: normal rotation on odd runs.
    const runningExtraRuns =
      ev.extraType === 'bye' || ev.extraType === 'leg_bye' || ev.extraType === 'wide'
        ? ev.runsExtras
        : ev.extraType === 'no_ball' && ev.secondaryExtraType
          ? ev.runsExtras
          : 0;
    const runsRun = ev.runsBatter + runningExtraRuns;
    if (runsRun % 2 === 1) [next.strikerId, next.nonStrikerId] = [next.nonStrikerId, next.strikerId];
  }

  // Over complete? (swap strike again at over change)
  if (isLegalDelivery && next.currentOverBalls === rules.balls_per_over) {
    effects.push({ kind: 'over_complete', overNumber: Math.floor(next.legalBalls / rules.balls_per_over) - 1 });
    next.currentOverBalls = 0;
    // In gully rotation mode with mid-over dismissals, don't update lastOverBowlerId
    // based on who finished the over — use the bowler-selection validation instead
    if (!rules.solo_batting?.enabled) {
      next.lastOverBowlerId = ev.bowlerId;
    }
    [next.strikerId, next.nonStrikerId] = [next.nonStrikerId, next.strikerId];
  }

  // ---- Rotation mode: per-batter quota -----------------------------------
  // A batter who uses up their allotted overs retires out and the next one
  // comes in. Skipped when the ball also dismissed them — that already
  // consumed the slot above, and firing both would push the same player onto
  // battersCompleted twice and end the innings a batter early.
  if (rules.solo_batting?.enabled && rules.solo_batting.retire_on_quota !== false
      && isLegalDelivery && !ev.wicket) {
    const faced = next.batterLegalBalls[ev.strikerId] ?? 0;
    if (faced >= rules.solo_batting.balls_per_batter
        && !next.battersCompleted.includes(ev.strikerId)) {
      next.battersCompleted.push(ev.strikerId);
      effects.push(
        { kind: 'batter_retired', playerId: ev.strikerId, reason: 'quota' },
        { kind: 'new_batter_required', dismissedId: ev.strikerId },
      );
    }
  }

  // ---- Innings / match termination ---------------------------------------
  if (next.target !== null && next.totalRuns >= next.target) {
    effects.push({ kind: 'innings_complete', reason: 'target_reached' }, { kind: 'match_complete', result: 'win' });
  } else if (rules.solo_batting?.enabled
             && next.battersCompleted.length >= rules.solo_batting.batter_count) {
    // Rotation mode's real terminating condition — covers a pool that was all
    // dismissed, all retired on quota, or any mix of the two.
    effects.push({ kind: 'innings_complete', reason: 'all_batted' });
    maybeCloseChase(next, rules, effects);
  } else if (next.totalWickets >= rules.wickets_to_fall) {
    effects.push({ kind: 'innings_complete', reason: 'all_out' });
    maybeCloseChase(next, rules, effects);
  } else if (next.maxOvers !== null && next.legalBalls >= next.maxOvers * rules.balls_per_over) {
    effects.push({ kind: 'innings_complete', reason: 'overs' });
    maybeCloseChase(next, rules, effects);
  }

  return { ok: true, next, effects };
}

/**
 * What an innings ending short of its target means for the match: a level score
 * is a tie (or a super over), anything less hands it to the defending side.
 * Returns null when the innings isn't a chase, so it just ends normally.
 *
 * Exported because an innings can also be closed outside the ball stream — a
 * declaration, or the scorer shortening the innings to the overs already
 * bowled — and those paths must reach the identical verdict.
 */
export function chaseCloseEffect(state: LiveInningsState, rules: FormatRules): SideEffect | null {
  if (state.target === null) return null; // first innings ends normally
  if (state.totalRuns === state.target - 1) {
    return rules.super_over?.enabled ? { kind: 'super_over_required' } : { kind: 'match_complete', result: 'tie' };
  }
  return { kind: 'match_complete', result: 'win' }; // defending side wins
}

function maybeCloseChase(next: LiveInningsState, rules: FormatRules, effects: SideEffect[]): void {
  const effect = chaseCloseEffect(next, rules);
  if (effect) effects.push(effect);
}

const err = (code: string, message: string): ValidationResult => ({ ok: false, code, message });
