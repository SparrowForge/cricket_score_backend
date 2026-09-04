import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { deepMerge } from '../common/deep-merge';
import { PG_POOL } from '../database/database.module';
import { StatsService } from '../matches/stats.service';
import { DraftFixture, FixtureConfig, generateFixtures } from './fixture-generator';

/**
 * The tournament-wide match settings, as the setup screen posts them. Stored as
 * the tournament's `rule_overrides` and deep-merged onto the format to become
 * each generated match's `rules_snapshot`.
 */
export interface MatchSettings {
  overs_per_innings?: number | null;
  players_per_side?: number | null;
  wickets_to_fall?: number | null;
  max_overs_per_bowler?: number | null;
  /** Convenience for API clients: derives `wickets_to_fall` from the squad size. */
  allow_last_single_batter?: boolean;
  no_ball?: { free_hit?: boolean; runs?: number } | null;
  dls?: { enabled?: boolean } | null;
}

export interface GenerateMatchesInput {
  match_settings?: MatchSettings;
  /** How many times each pair of teams meets. 3 teams × 3 = 9 matches. */
  matches_per_pair?: number;
  /** Required once the tournament already has fixtures — replaces them. */
  overwrite?: boolean;
  /** Build and return the fixture list without saving anything. */
  preview?: boolean;
  start_date?: string;
  match_days?: number[];
  matches_per_day?: number;
  venue_ids?: string[];
}

/** A pair can meet at most this often in one tournament. */
const MAX_MATCHES_PER_PAIR = 20;
/**
 * Ceiling on a single generation run. 20 teams already means 190 fixtures for
 * one round robin, and a mistyped "matches per pair" would otherwise insert
 * thousands of rows — and there is no undo but deleting them one by one.
 */
const MAX_GENERATED_MATCHES = 500;
/** Rows per INSERT. Keeps the statement (and its parameter list) bounded. */
const INSERT_CHUNK = 100;
const DEFAULT_PLAYERS_PER_SIDE = 11;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Validate the settings form and turn it into a `rule_overrides` document.
 *
 * Returns field-keyed messages rather than throwing on the first problem, so
 * the UI can pin every error under its own input in one round trip. Only the
 * fields the admin actually set become overrides — everything else stays
 * inherited from the format, which is what makes one screen work for T10
 * through Test.
 *
 * `fields` blocks the write; `warnings` does not. A setting can be odd without
 * being wrong — short-format club cricket routinely caps bowlers below what it
 * would take to bowl the innings out — and refusing to save a combination that
 * organisers already play would be the tool overruling the umpire.
 */
export function normalizeMatchSettings(input: MatchSettings, formatRules: Record<string, any> | null | undefined) {
  const fields: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const format = formatRules ?? {};

  const overs = input.overs_per_innings ?? null;
  if (overs !== null) {
    if (!isInt(overs) || overs < 1 || overs > 500) fields.overs_per_innings = 'Overs per innings must be a whole number between 1 and 500';
    else out.overs_per_innings = overs;
  }

  const players = input.players_per_side ?? null;
  if (players !== null) {
    if (!isInt(players) || players < 2 || players > 15) fields.players_per_side = 'Players per side must be between 2 and 15';
    else out.players_per_side = players;
  }

  // Effective values after inheritance — the checks below are about the match
  // that will actually be played, not only about what was typed on this form.
  const effPlayers = (out.players_per_side as number) ?? format.players_per_side ?? DEFAULT_PLAYERS_PER_SIDE;
  const effOvers = (out.overs_per_innings as number) ?? format.overs_per_innings ?? null;

  const maxPerBowler = input.max_overs_per_bowler ?? null;
  if (maxPerBowler !== null) {
    if (!isInt(maxPerBowler) || maxPerBowler < 1) {
      fields.max_overs_per_bowler = 'Max overs per bowler must be a whole number of at least 1';
    } else if (effOvers !== null && maxPerBowler > effOvers) {
      fields.max_overs_per_bowler = `Cannot exceed the ${effOvers} overs in an innings`;
    } else {
      out.max_overs_per_bowler = maxPerBowler;
      // 10 bowlers × 2 overs cannot cover a 25-over innings — the side runs out
      // of legal bowlers before the overs run out. Worth saying out loud, but
      // it is the organiser's call, not a reason to refuse the tournament.
      const capacity = (effPlayers - 1) * maxPerBowler;
      if (effOvers !== null && capacity < effOvers) {
        warnings.max_overs_per_bowler =
          `${effPlayers - 1} bowlers × ${maxPerBowler} overs covers only ${capacity} of the ${effOvers} overs — the innings can run out of eligible bowlers`;
      }
    }
  }

  /**
   * `wickets_to_fall` is derived, never typed. Equal to the squad size is what
   * the rules engine reads as "last man bats alone"; one below is the ordinary
   * rule where the innings ends when the last batter is left without a partner.
   */
  let wickets = input.wickets_to_fall ?? null;
  if (input.allow_last_single_batter !== undefined) {
    wickets = effPlayers - (input.allow_last_single_batter ? 0 : 1);
  }
  if (wickets !== null) {
    if (!isInt(wickets) || wickets < 1 || wickets > effPlayers) {
      fields.wickets_to_fall = `Wickets to fall must be between 1 and the squad size (${effPlayers})`;
    } else if (wickets !== format.wickets_to_fall) {
      out.wickets_to_fall = wickets;
    }
  }

  // Booleans have no blank state, so they are written only when they differ
  // from the format — otherwise an untouched form would pin the checkbox's
  // default onto a format that ships the opposite value.
  if (input.no_ball?.free_hit !== undefined && input.no_ball.free_hit !== (format.no_ball?.free_hit ?? true)) {
    out.no_ball = { free_hit: input.no_ball.free_hit };
  }
  if (input.dls?.enabled !== undefined && input.dls.enabled !== (format.dls?.enabled ?? true)) {
    out.dls = { enabled: input.dls.enabled };
  }

  return { overrides: out, fields, warnings };
}

@Injectable()
export class TournamentsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly stats: StatsService,
  ) {}

  // ---------- Tournaments ----------
  async list(filter: { org?: string; status?: string }) {
    return (
      await this.pool.query(
        `SELECT t.id, t.name, t.slug, t.season, t.status, t.start_date, t.end_date, t.banner_url,
                t.organization_id, t.player_of_tournament_id, f.name AS format, f.slug AS format_slug,
                (SELECT count(*)::int FROM tournament_teams tt WHERE tt.tournament_id = t.id) AS team_count,
                (SELECT count(*)::int FROM matches m WHERE m.tournament_id = t.id) AS match_count
         FROM tournaments t JOIN match_formats f ON f.id = t.format_id
         WHERE t.deleted_at IS NULL
           AND ($1::uuid IS NULL OR t.organization_id = $1)
           AND ($2::text IS NULL OR t.status::text = $2)
           AND (t.is_public OR $1 IS NOT NULL)
         ORDER BY t.start_date DESC NULLS LAST LIMIT 100`,
        [filter.org ?? null, filter.status ?? null],
      )
    ).rows;
  }

  async create(orgId: string, userId: string, dto: any) {
    const res = await this.pool.query(
      `INSERT INTO tournaments (organization_id, name, slug, season, format_id, start_date, end_date,
                                banner_url, description, rule_overrides, points_rules, is_public, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10,'{}'::jsonb),
               coalesce($11, '{"win":2,"loss":0,"tie":1,"no_result":1,"tiebreakers":["points","nrr","head_to_head","wins"]}'::jsonb),
               coalesce($12, true), $13)
       ON CONFLICT (organization_id, slug) DO NOTHING RETURNING *`,
      [orgId, dto.name, dto.slug, dto.season ?? null, dto.format_id, dto.start_date ?? null, dto.end_date ?? null,
       dto.banner_url ?? null, dto.description ?? null,
       dto.rule_overrides ? JSON.stringify(dto.rule_overrides) : null,
       dto.points_rules ? JSON.stringify(dto.points_rules) : null,
       dto.is_public, userId],
    );
    if (res.rowCount === 0) throw new ConflictException('Tournament slug already exists');
    return res.rows[0];
  }

  async get(id: string) {
    const t = (
      await this.pool.query(
        `SELECT t.*, f.name AS format_name, f.slug AS format_slug, f.rules AS format_rules,
                pot.full_name AS player_of_tournament_name, pot.photo_url AS player_of_tournament_photo
         FROM tournaments t JOIN match_formats f ON f.id = t.format_id
         LEFT JOIN players pot ON pot.id = t.player_of_tournament_id
         WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [id],
      )
    ).rows[0];
    if (!t) throw new NotFoundException('Tournament not found');
    t.groups = (await this.pool.query(`SELECT * FROM tournament_groups WHERE tournament_id = $1 ORDER BY sort_order`, [id])).rows;
    t.teams = (
      await this.pool.query(
        `SELECT tt.id AS tournament_team_id, tt.group_id, tt.seed, tm.id, tm.name, tm.short_name, tm.logo_url
         FROM tournament_teams tt JOIN teams tm ON tm.id = tt.team_id
         WHERE tt.tournament_id = $1 ORDER BY tt.seed NULLS LAST, tm.name`,
        [id],
      )
    ).rows;
    return t;
  }

  /**
   * The tournament's MVP leader, or null before any match has been finalised.
   *
   * Ranks on the true total, not the floored one `leaderboard()` displays: a
   * board where every player is negative still has a leader, and flooring
   * first would tie them all at 0.
   */
  private async mvpLeader(tournamentId: string): Promise<string | null> {
    return (
      await this.pool.query(
        `SELECT player_id FROM player_tournament_stats
         WHERE tournament_id = $1
         ORDER BY mvp_points DESC, runs_scored DESC, wickets_taken DESC
         LIMIT 1`,
        [tournamentId],
      )
    ).rows[0]?.player_id ?? null;
  }

  /** A player can only take the award for a tournament they actually played in. */
  private async assertTournamentPlayer(tournamentId: string, playerId: string) {
    const ok = await this.pool.query(
      `SELECT 1 FROM player_tournament_stats WHERE tournament_id = $1 AND player_id = $2`,
      [tournamentId, playerId],
    );
    if (ok.rowCount === 0) {
      throw new BadRequestException('That player has no recorded appearance in this tournament');
    }
  }

  async update(id: string, dto: any) {
    const before = (
      await this.pool.query(
        `SELECT format_id, status, player_of_tournament_id
         FROM tournaments WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      )
    ).rows[0];
    if (!before) throw new NotFoundException('Tournament not found');

    // Player of the Tournament: an explicit pick always wins. Otherwise, the
    // first time this tournament is marked completed the MVP leader is written
    // in as the default — mirroring `stats.service` seeding player_of_match
    // from the match MVP board at finalize. Seeded only on the transition, so
    // re-saving a completed tournament never overwrites a hand-picked winner,
    // and only when one is not already set.
    let playerOfTournament: string | null = dto.player_of_tournament_id ?? null;
    if (!playerOfTournament && dto.status === 'completed' && before.status !== 'completed'
        && !before.player_of_tournament_id) {
      playerOfTournament = await this.mvpLeader(id);
    }
    if (playerOfTournament) await this.assertTournamentPlayer(id, playerOfTournament);

    const res = await this.pool.query(
      `UPDATE tournaments SET
         name = coalesce($2,name), season = coalesce($3,season), status = coalesce($4::tournament_status,status),
         start_date = coalesce($5,start_date), end_date = coalesce($6,end_date),
         banner_url = coalesce($7,banner_url), description = coalesce($8,description),
         rule_overrides = coalesce($9,rule_overrides), points_rules = coalesce($10,points_rules),
         is_public = coalesce($11,is_public), format_id = coalesce($12,format_id),
         player_of_tournament_id = coalesce($13::uuid,player_of_tournament_id)
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, dto.name ?? null, dto.season ?? null, dto.status ?? null, dto.start_date ?? null, dto.end_date ?? null,
       dto.banner_url ?? null, dto.description ?? null,
       dto.rule_overrides ? JSON.stringify(dto.rule_overrides) : null,
       dto.points_rules ? JSON.stringify(dto.points_rules) : null, dto.is_public ?? null,
       dto.format_id ?? null, playerOfTournament],
    );
    if (res.rowCount === 0) throw new NotFoundException('Tournament not found');

    // The format decides which career `format_family` this tournament's matches
    // roll into, and those rows were written back at finalize time. Without
    // this the change only reaches matches finalised from now on, and every
    // player who already played here keeps a career row filed under the old
    // format. Existing matches keep their frozen `rules_snapshot` either way —
    // this re-files the stats, it does not re-score anything.
    if (dto.format_id && dto.format_id !== before.format_id) {
      await this.stats.rebuildCareerStatsForTournament(id);
    }
    return res.rows[0];
  }

  /**
   * Re-file every participant's *career* totals for a tournament that already
   * has results.
   *
   * The repair hatch for career rows that went stale because the family they
   * were bucketed into changed underneath them — chiefly a format switch. It
   * is a rebuild from `player_match_stats`, so running it twice is a no-op.
   *
   * Scope is deliberately career-only: `player_tournament_stats` and the points
   * table are not keyed by format family, so a format switch cannot stale them.
   * Repairing those (after a match deleted straight from the database, say)
   * needs `rebuildTournamentStats`/`rebuildPointsTable`, which this does not call.
   */
  async recalculateStats(id: string) {
    const t = (
      await this.pool.query(`SELECT id FROM tournaments WHERE id = $1 AND deleted_at IS NULL`, [id])
    ).rows[0];
    if (!t) throw new NotFoundException('Tournament not found');
    return this.stats.rebuildCareerStatsForTournament(id);
  }

  async remove(id: string) {
    await this.pool.query(`UPDATE tournaments SET deleted_at = now() WHERE id = $1`, [id]);
    return { deleted: true };
  }

  // ---------- Groups & teams ----------
  async createGroup(tournamentId: string, name: string, sortOrder = 0) {
    const res = await this.pool.query(
      `INSERT INTO tournament_groups (tournament_id, name, sort_order) VALUES ($1,$2,$3)
       ON CONFLICT (tournament_id, name) DO NOTHING RETURNING *`,
      [tournamentId, name, sortOrder],
    );
    if (res.rowCount === 0) throw new ConflictException('Group name already exists');
    return res.rows[0];
  }

  async attachTeam(tournamentId: string, dto: { team_id: string; group_id?: string; seed?: number }) {
    const res = await this.pool.query(
      `INSERT INTO tournament_teams (tournament_id, team_id, group_id, seed)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tournament_id, team_id) DO UPDATE SET group_id = excluded.group_id, seed = excluded.seed
       RETURNING *`,
      [tournamentId, dto.team_id, dto.group_id ?? null, dto.seed ?? null],
    );
    // Seed points-table row so the table is complete before any result
    await this.pool.query(
      `INSERT INTO points_table_entries (tournament_id, group_id, team_id)
       VALUES ($1, $3, $2) ON CONFLICT (tournament_id, team_id) DO UPDATE SET group_id = excluded.group_id`,
      [tournamentId, dto.team_id, dto.group_id ?? null],
    );
    await this.rerankPointsTable(tournamentId);
    return res.rows[0];
  }

  async detachTeam(tournamentId: string, teamId: string) {
    await this.pool.query(`DELETE FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2`, [tournamentId, teamId]);
    await this.pool.query(`DELETE FROM points_table_entries WHERE tournament_id = $1 AND team_id = $2`, [tournamentId, teamId]);
    await this.rerankPointsTable(tournamentId);
    return { detached: true };
  }

  /** Ranks go stale when rows are added/removed outside a stats rebuild. */
  private async rerankPointsTable(tournamentId: string) {
    await this.pool.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (PARTITION BY group_id ORDER BY points DESC, net_run_rate DESC, won DESC) AS rk
         FROM points_table_entries WHERE tournament_id = $1
       )
       UPDATE points_table_entries pte SET rank = ranked.rk FROM ranked WHERE ranked.id = pte.id`,
      [tournamentId],
    );
  }

  async pointsTable(tournamentId: string) {
    return (
      await this.pool.query(
        `SELECT pte.*, tm.name AS team_name, tm.short_name, tm.logo_url, g.name AS group_name
         FROM points_table_entries pte
         JOIN teams tm ON tm.id = pte.team_id
         LEFT JOIN tournament_groups g ON g.id = pte.group_id
         WHERE pte.tournament_id = $1
         ORDER BY g.sort_order NULLS FIRST, pte.points DESC, pte.net_run_rate DESC`,
        [tournamentId],
      )
    ).rows;
  }

  // ---------- Fixtures ----------
  /** Generate draft fixtures (round_robin | knockout | hybrid). Nothing is saved — review then confirm. */
  async generate(tournamentId: string, cfg: Omit<FixtureConfig, 'groups'>): Promise<DraftFixture[]> {
    const teams = (
      await this.pool.query(
        `SELECT team_id, group_id FROM tournament_teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST`,
        [tournamentId],
      )
    ).rows;
    if (teams.length < 2) throw new BadRequestException('Attach at least 2 teams first');
    if (!cfg.venueIds?.length) throw new BadRequestException('Provide at least one venue');

    const groups = new Map<string, string[]>();
    for (const t of teams) {
      if (t.group_id) groups.set(t.group_id, [...(groups.get(t.group_id) ?? []), t.team_id]);
    }
    const full: FixtureConfig = {
      ...cfg,
      groups: cfg.type === 'hybrid'
        ? [...groups.entries()].map(([id, teamIds]) => ({ id, teamIds }))
        : undefined,
    } as FixtureConfig;

    return generateFixtures(teams.map((t) => t.team_id), full);
  }

  /** Persist reviewed fixtures as scheduled matches. */
  async confirmFixtures(tournamentId: string, fixtures: DraftFixture[]) {
    const t = (
      await this.pool.query(`SELECT organization_id FROM tournaments WHERE id = $1`, [tournamentId])
    ).rows[0];
    if (!t) throw new NotFoundException('Tournament not found');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created: string[] = [];
      let matchNumber =
        (await client.query(`SELECT coalesce(max(match_number),0)::int AS n FROM matches WHERE tournament_id = $1`, [tournamentId]))
          .rows[0].n;

      for (const f of fixtures) {
        if (!f.teamAId || !f.teamBId) continue; // TBD knockout slots are created when the table settles
        matchNumber += 1;
        const row = await client.query(
          `INSERT INTO matches (tournament_id, organization_id, match_number, stage, stage_label, group_id,
                                team_a_id, team_b_id, venue_id, scheduled_start)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [tournamentId, t.organization_id, matchNumber, f.stage ?? 'league', f.stageLabel ?? null,
           (f as any).groupId ?? null, f.teamAId, f.teamBId, f.venueId, f.scheduledStart],
        );
        created.push(row.rows[0].id);
      }
      await client.query('COMMIT');
      return { created: created.length, match_ids: created };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * One-shot setup: validate, save the tournament's match settings, then create
   * the round-robin fixtures that play by them.
   *
   * Every fixture is written with its own `rules_snapshot` (format rules +
   * these settings), so a match is complete the moment it is created and later
   * edits to the tournament cannot silently change a fixture the admin has
   * already reviewed. `toss()` prefers an existing snapshot, so this is the same
   * path `createManual` uses for one-off matches.
   *
   * Settings are saved even when zero fixtures result, and nothing is written at
   * all if any part fails — the whole thing runs in one transaction.
   */
  async generateMatches(tournamentId: string, dto: GenerateMatchesInput) {
    const t = (
      await this.pool.query(
        `SELECT t.id, t.organization_id, t.start_date, f.rules AS format_rules, f.name AS format_name
         FROM tournaments t JOIN match_formats f ON f.id = t.format_id
         WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [tournamentId],
      )
    ).rows[0];
    if (!t) throw new NotFoundException('Tournament not found');

    // ---- 1. Validate everything, then report it all at once ----
    const fields: Record<string, string> = {};

    const teams: string[] = (
      await this.pool.query(
        `SELECT team_id FROM tournament_teams WHERE tournament_id = $1 ORDER BY seed NULLS LAST, team_id`,
        [tournamentId],
      )
    ).rows.map((r) => r.team_id);
    if (teams.length < 2) fields.teams = 'Attach at least 2 teams before generating fixtures';

    const perPair = dto.matches_per_pair ?? 1;
    if (!isInt(perPair) || perPair < 1 || perPair > MAX_MATCHES_PER_PAIR) {
      fields.matches_per_pair = `Enter a whole number between 1 and ${MAX_MATCHES_PER_PAIR}`;
    }

    const { overrides, fields: ruleFields, warnings } = normalizeMatchSettings(dto.match_settings ?? {}, t.format_rules);
    Object.assign(fields, ruleFields);

    // Venues are org-wide; taking them from the org keeps the client payload to
    // the two things the admin actually chose.
    const venueIds: string[] = (
      await this.pool.query(
        // An empty list means "any venue this org owns" — one statement either
        // way, since Postgres needs every parameter it can see to be supplied.
        `SELECT id FROM venues
         WHERE organization_id = $2
           AND (cardinality($1::uuid[]) = 0 OR id = ANY($1::uuid[]))
         ORDER BY name`,
        [dto.venue_ids ?? [], t.organization_id],
      )
    ).rows.map((r) => r.id);
    if (!venueIds.length) fields.venues = 'Add a venue for this organization first (Venues tab)';

    const pairings = (teams.length * (teams.length - 1)) / 2;
    const total = pairings * perPair;
    if (Object.keys(fields).length === 0 && total > MAX_GENERATED_MATCHES) {
      fields.matches_per_pair =
        `${teams.length} teams × ${perPair} per pair = ${total} matches, over the ${MAX_GENERATED_MATCHES} allowed in one run`;
    }
    if (Object.keys(fields).length) {
      throw new BadRequestException({ message: 'Check the highlighted fields and try again', fields });
    }

    // ---- 2. Fixtures ----
    // A weekday outside 1–7 can never match a date, and the scheduler walks the
    // calendar until one does — so anything out of range is dropped, not trusted.
    const matchDays = (dto.match_days ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    const cfg: FixtureConfig = {
      type: 'round_robin',
      legs: 1,
      matchesPerPair: perPair,
      startDate: dto.start_date ?? isoDate(t.start_date) ?? isoDate(new Date())!,
      matchDays: matchDays.length ? matchDays : [1, 2, 3, 4, 5, 6, 7],
      matchesPerDay: dto.matches_per_day ?? Math.max(1, venueIds.length),
      venueIds,
    };
    const fixtures = generateFixtures(teams, cfg);
    const rulesSnapshot = deepMerge(t.format_rules, overrides);

    if (dto.preview) {
      const names = new Map<string, string>(
        (await this.pool.query(`SELECT id, name FROM teams WHERE id = ANY($1::uuid[])`, [teams])).rows
          .map((r) => [r.id, r.name] as [string, string]),
      );
      return {
        preview: true,
        teams: teams.length,
        matches_per_pair: perPair,
        total: fixtures.length,
        match_settings: overrides,
        warnings,
        rules_snapshot: rulesSnapshot,
        fixtures: fixtures.map((f, i) => ({
          match_number: i + 1,
          team_a: names.get(f.teamAId ?? '') ?? null,
          team_b: names.get(f.teamBId ?? '') ?? null,
          scheduled_start: f.scheduledStart,
        })),
      };
    }

    // ---- 3. Regeneration guard ----
    const existing = (
      await this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (
                  WHERE status = 'scheduled' AND NOT is_super_over AND parent_match_id IS NULL
                )::int AS replaceable
         FROM matches WHERE tournament_id = $1`,
        [tournamentId],
      )
    ).rows[0];
    const played = existing.total - existing.replaceable;

    /**
     * Regenerating is destructive, so it needs an explicit `overwrite` — the
     * client turns this 409 into the confirmation prompt.
     *
     * Only fixtures still waiting at `scheduled` are ever deleted. A match that
     * has reached the toss owns a ball stream, a scorecard, career stats and a
     * points-table row; those are kept and reported back as `kept`, which also
     * leaves the ordinary "add more fixtures to a running tournament" case
     * working instead of blocking it.
     */
    if (existing.total > 0 && !dto.overwrite) {
      throw new ConflictException({
        code: 'MATCHES_EXIST',
        message: `This tournament already has ${existing.total} match${existing.total === 1 ? '' : 'es'}. Regenerating replaces the ${existing.replaceable} not yet played.`,
        existing: existing.total,
        replaceable: existing.replaceable,
        played,
      });
    }

    // ---- 4. Persist: settings + fixtures, all or nothing ----
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tournaments SET rule_overrides = $2::jsonb WHERE id = $1`, [
        tournamentId,
        JSON.stringify(overrides),
      ]);

      const deleted = dto.overwrite ? await this.purgeScheduledMatches(client, tournamentId) : 0;

      let matchNumber = (
        await client.query(`SELECT coalesce(max(match_number),0)::int AS n FROM matches WHERE tournament_id = $1`, [
          tournamentId,
        ])
      ).rows[0].n;

      const playable = fixtures.filter((f) => f.teamAId && f.teamBId);
      const matchIds: string[] = [];
      const snapshotJson = JSON.stringify(rulesSnapshot);

      for (let i = 0; i < playable.length; i += INSERT_CHUNK) {
        const chunk = playable.slice(i, i + INSERT_CHUNK);
        const values: unknown[] = [tournamentId, t.organization_id, snapshotJson];
        const rows = chunk.map((f) => {
          const p = values.length;
          values.push(++matchNumber, f.teamAId, f.teamBId, f.venueId, f.scheduledStart);
          return `($1,$2,$${p + 1},'league'::fixture_stage,$${p + 2},$${p + 3},$${p + 4},$${p + 5},$3::jsonb)`;
        });
        const res = await client.query(
          `INSERT INTO matches (tournament_id, organization_id, match_number, stage,
                                team_a_id, team_b_id, venue_id, scheduled_start, rules_snapshot)
           VALUES ${rows.join(',')} RETURNING id`,
          values,
        );
        matchIds.push(...res.rows.map((r) => r.id));
      }

      await client.query('COMMIT');
      return {
        generated: matchIds.length,
        deleted,
        kept: played,
        teams: teams.length,
        matches_per_pair: perPair,
        match_settings: overrides,
        warnings,
        rules_snapshot: rulesSnapshot,
        match_ids: matchIds,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Drop the fixtures a regeneration replaces. Pre-toss rows only — anything
   * that has started is refused before we get here — so there are no innings,
   * balls or stats to unwind. Squads and officials do not cascade from
   * `matches`, so they go explicitly; super-over children are skipped because
   * their parent still points at them.
   */
  private async purgeScheduledMatches(client: PoolClient, tournamentId: string): Promise<number> {
    const ids: string[] = (
      await client.query(
        `SELECT id FROM matches m
         WHERE m.tournament_id = $1 AND m.status = 'scheduled'
           AND NOT m.is_super_over AND m.parent_match_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM innings i WHERE i.match_id = m.id)`,
        [tournamentId],
      )
    ).rows.map((r) => r.id);
    if (!ids.length) return 0;

    await client.query(`DELETE FROM match_players WHERE match_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM match_officials WHERE match_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM match_interruptions WHERE match_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM matches WHERE id = ANY($1::uuid[])`, [ids]);
    return ids.length;
  }
}

const isoDate = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString().slice(0, 10) : null;
