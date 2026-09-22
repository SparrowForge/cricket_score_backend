import { BallEvent, FormatRules } from './rules-engine';

/**
 * How many ball labels `live_state.recent_ball_labels` keeps: a rolling window
 * that runs across over boundaries (three overs' worth), unlike `this_over`,
 * which is cleared at the end of every over. The public scoreboard reads this
 * one; the scorer console still reads `this_over`.
 *
 * Unrelated to LiveStateService.recentBalls(), which is the Redis stream of
 * raw ball events.
 */
export const RECENT_BALL_WINDOW = 18;

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
