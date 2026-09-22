import { BallEvent, FormatRules } from './rules-engine';

/**
 * How many overs `live_state.recent_overs` keeps — the viewer-facing window of
 * recent play, one group per over ("5th, 11 runs: 1 1 4 1 0 4"). Whole overs,
 * not a flat ball count, so the runs figure on the oldest group always covers
 * the balls shown under it. The scorer console still reads `this_over`.
 *
 * Unrelated to LiveStateService.recentBalls(), which is the Redis stream of
 * raw ball events.
 */
export const RECENT_OVERS = 3;

/** One over of the viewer-facing window. `over` is 0-based, as in the balls table. */
export interface RecentOver {
  over: number;
  runs: number;
  balls: string[];
}

/** The chip shown on a scoreboard for one delivery ('4', 'W', '2wd', 'nb+1lb'…). */
export function ballLabel(ev: BallEvent, four: boolean, six: boolean): string {
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
 * Same label, from a stored `balls` row. A row's runs_extras already includes
 * the automatic wide/no-ball penalty, but ballLabel expects only the runs
 * beyond it (a plain wide must render 'wd', not '2wd'), so the penalty is
 * stripped back out here.
 */
export function ballLabelFromRow(b: any, rules: Partial<FormatRules>): string {
  const autoPenalty = b.extra_type === 'wide' ? rules.wide?.runs ?? 1
    : b.extra_type === 'no_ball' ? rules.no_ball?.runs ?? 1 : 0;
  return ballLabel(
    {
      runsBatter: b.runs_batter, extraType: b.extra_type, runsExtras: b.runs_extras - autoPenalty,
      secondaryExtraType: b.secondary_extra_type ?? null, wicket: b.is_wicket ? ({} as any) : null,
    } as any,
    b.is_boundary_four, b.is_boundary_six,
  );
}

/**
 * Fold one delivery into the window, opening a new group when the over turns
 * and dropping the oldest once RECENT_OVERS are held. Returns a new array —
 * the live_state value is JSON-serialised as it stands, so nothing is mutated
 * in place.
 */
export function pushRecentOver(
  recent: RecentOver[] | undefined, overNumber: number, label: string, runs: number,
): RecentOver[] {
  const out = [...(recent ?? [])];
  const last = out[out.length - 1];
  if (last && last.over === overNumber) {
    out[out.length - 1] = { over: last.over, runs: last.runs + runs, balls: [...last.balls, label] };
  } else {
    out.push({ over: overNumber, runs, balls: [label] });
  }
  return out.slice(-RECENT_OVERS);
}

/**
 * Rebuild the window from stored `balls` rows — the whole innings, or just its
 * tail, as long as they are ordered by seq ascending.
 */
export function recentOversFromRows(rows: any[], rules: Partial<FormatRules>): RecentOver[] {
  const out: RecentOver[] = [];
  for (const b of rows) {
    const last = out[out.length - 1];
    const group = last && last.over === b.over_number ? last : null;
    if (!group) out.push({ over: b.over_number, runs: 0, balls: [] });
    const cur = out[out.length - 1];
    cur.balls.push(ballLabelFromRow(b, rules));
    cur.runs += (b.runs_batter ?? 0) + (b.runs_extras ?? 0);
  }
  return out.slice(-RECENT_OVERS);
}
