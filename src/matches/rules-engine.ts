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
}

export type SideEffect =
  | { kind: 'over_complete'; overNumber: number }
  | { kind: 'innings_complete'; reason: 'all_out' | 'overs' | 'target_reached' | 'declared' }
  | { kind: 'match_complete'; result: 'win' | 'tie' }
  | { kind: 'super_over_required' }
  | { kind: 'new_batter_required'; dismissedId: string }
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
  }

  if (ev.wicket) {
    if (ev.wicket.type !== 'retired_hurt') next.totalWickets += 1;
    else next.battersRetiredHurt.push(ev.wicket.dismissedPlayerId);
    effects.push({ kind: 'new_batter_required', dismissedId: ev.wicket.dismissedPlayerId });
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
  if (ev.wicket?.type === 'run_out' && ev.wicket.wicketBrokenEnd) {
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
    next.lastOverBowlerId = ev.bowlerId;
    [next.strikerId, next.nonStrikerId] = [next.nonStrikerId, next.strikerId];
  }

  // ---- Innings / match termination ---------------------------------------
  if (next.target !== null && next.totalRuns >= next.target) {
    effects.push({ kind: 'innings_complete', reason: 'target_reached' }, { kind: 'match_complete', result: 'win' });
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
