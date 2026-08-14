/**
 * Resolve a rules document: format rules as the base, overrides layered on top.
 *
 * Only plain objects merge key by key — arrays and scalars are replaced whole.
 * That is what lets an override carry `{no_ball:{free_hit:false}}` without
 * dropping the format's own `no_ball.runs`.
 *
 * Lives in `common/` because both the match path (`matches.service.ts`,
 * `scoring.service.ts`) and the tournament path (`tournaments.service.ts`,
 * which freezes the same document onto every generated fixture) need it, and a
 * second copy is exactly how the two would drift.
 */
export function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || typeof override !== 'object' || Array.isArray(base) || Array.isArray(override)) {
    return override;
  }
  const out: any = { ...base };
  for (const key of Object.keys(override)) out[key] = deepMerge(base?.[key], override[key]);
  return out;
}
