/**
 * Auto fixture generator: round robin (circle method), knockout (seeded
 * bracket with byes), and hybrid (groups -> knockout). Pure function; the
 * controller returns the draft for admin review and persists on confirm.
 */

export interface FixtureConfig {
  type: 'round_robin' | 'knockout' | 'hybrid';
  legs: 1 | 2;                       // double round robin support
  knockoutFrom?: number;             // hybrid: top-N advance (per table, or per group)
  groups?: { id: string; teamIds: string[] }[];
  startDate: string;                 // ISO date
  matchDays: number[];               // ISO weekday numbers, e.g. [6,7]
  matchesPerDay: number;
  venueIds: string[];
}

export interface DraftFixture {
  stage: 'group' | 'league' | 'quarter_final' | 'semi_final' | 'final';
  stageLabel?: string;
  groupId?: string;
  teamAId: string | null;            // null = TBD (winner of an earlier fixture)
  teamBId: string | null;
  dependsOn?: { a?: number; b?: number }; // indexes of prerequisite fixtures
  scheduledStart: Date;
  venueId: string;
}

export function generateFixtures(teamIds: string[], cfg: FixtureConfig): DraftFixture[] {
  switch (cfg.type) {
    case 'round_robin': return schedule(roundRobin(teamIds, cfg.legs), 'league', cfg);
    case 'knockout':    return schedule(knockout(teamIds), null, cfg);
    case 'hybrid': {
      const groupGames = (cfg.groups ?? []).flatMap((g) =>
        roundRobin(g.teamIds, cfg.legs).map((p) => ({ ...p, groupId: g.id })),
      );
      const draft = schedule(groupGames, 'group', cfg);
      // Knockout slots are TBD until the points table settles.
      const koSlots = knockout(Array.from({ length: cfg.knockoutFrom ?? 4 }, () => null as string | null));
      return draft.concat(schedule(koSlots, null, cfg, draft.length));
    }
  }
}

/** Circle method: fix team[0], rotate the rest. Handles odd counts via a bye. */
function roundRobin(teamIds: (string | null)[], legs: 1 | 2) {
  const teams = teamIds.length % 2 === 0 ? [...teamIds] : [...teamIds, null /* bye */];
  const n = teams.length;
  const rounds: { teamAId: string | null; teamBId: string | null; stage: DraftFixture['stage'] }[] = [];

  for (let leg = 0; leg < legs; leg++) {
    const rot = teams.slice(1);
    for (let r = 0; r < n - 1; r++) {
      const lineup = [teams[0], ...rot];
      for (let i = 0; i < n / 2; i++) {
        const [a, b] = [lineup[i], lineup[n - 1 - i]];
        if (a === null || b === null) continue; // bye
        rounds.push(leg === 0 ? { teamAId: a, teamBId: b, stage: 'league' }
                              : { teamAId: b, teamBId: a, stage: 'league' }); // reverse home/away
      }
      rot.unshift(rot.pop()!);
    }
  }
  return rounds;
}

/** Seeded single-elimination bracket; pads to a power of two with byes. */
function knockout(seeds: (string | null)[]) {
  const size = 2 ** Math.ceil(Math.log2(Math.max(seeds.length, 2)));
  const padded: (string | null)[] = [...seeds, ...Array(size - seeds.length).fill(null)];
  const order = bracketOrder(size); // 1v(n), (n/2)v(n/2+1)… standard seeding
  const stageOf = (remaining: number): DraftFixture['stage'] =>
    remaining === 2 ? 'final' : remaining === 4 ? 'semi_final' : 'quarter_final';

  const fixtures: any[] = [];
  let round = order.map((i) => padded[i - 1]);
  let prevRoundStart = 0;
  while (round.length > 1) {
    const stage = stageOf(round.length);
    const thisRoundStart = fixtures.length;
    for (let i = 0; i < round.length; i += 2) {
      fixtures.push({
        teamAId: round[i], teamBId: round[i + 1], stage,
        dependsOn: fixtures.length >= round.length / 2 && thisRoundStart > 0
          ? { a: prevRoundStart + i, b: prevRoundStart + i + 1 } : undefined,
      });
    }
    prevRoundStart = thisRoundStart;
    round = Array(round.length / 2).fill(null); // winners TBD
  }
  return fixtures;
}

function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next: number[] = [];
    const len = order.length * 2;
    for (const s of order) next.push(s, len + 1 - s);
    order = next;
  }
  return order;
}

/** Assign dates/venues respecting match days, matches/day, and venue capacity (1 match/venue/slot). */
function schedule(pairs: any[], stageOverride: string | null, cfg: FixtureConfig, offset = 0): DraftFixture[] {
  const out: DraftFixture[] = [];
  let cursor = nextMatchDay(new Date(cfg.startDate), cfg.matchDays);
  let slotInDay = 0;

  for (const p of pairs) {
    const venueId = cfg.venueIds[slotInDay % cfg.venueIds.length];
    out.push({ ...p, stage: stageOverride ?? p.stage, scheduledStart: new Date(cursor), venueId });
    slotInDay++;
    if (slotInDay >= Math.min(cfg.matchesPerDay, cfg.venueIds.length)) {
      slotInDay = 0;
      cursor = nextMatchDay(addDays(cursor, 1), cfg.matchDays);
    }
  }
  return out;
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
function nextMatchDay(from: Date, matchDays: number[]): Date {
  let d = new Date(from);
  while (!matchDays.includes(((d.getDay() + 6) % 7) + 1)) d = addDays(d, 1); // ISO weekday
  return d;
}
