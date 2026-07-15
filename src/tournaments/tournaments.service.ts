import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { DraftFixture, FixtureConfig, generateFixtures } from './fixture-generator';

@Injectable()
export class TournamentsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---------- Tournaments ----------
  async list(filter: { org?: string; status?: string }) {
    return (
      await this.pool.query(
        `SELECT t.id, t.name, t.slug, t.season, t.status, t.start_date, t.end_date, t.banner_url,
                t.organization_id, f.name AS format, f.slug AS format_slug,
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
        `SELECT t.*, f.name AS format_name, f.slug AS format_slug, f.rules AS format_rules
         FROM tournaments t JOIN match_formats f ON f.id = t.format_id
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

  async update(id: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE tournaments SET
         name = coalesce($2,name), season = coalesce($3,season), status = coalesce($4::tournament_status,status),
         start_date = coalesce($5,start_date), end_date = coalesce($6,end_date),
         banner_url = coalesce($7,banner_url), description = coalesce($8,description),
         rule_overrides = coalesce($9,rule_overrides), points_rules = coalesce($10,points_rules),
         is_public = coalesce($11,is_public)
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, dto.name ?? null, dto.season ?? null, dto.status ?? null, dto.start_date ?? null, dto.end_date ?? null,
       dto.banner_url ?? null, dto.description ?? null,
       dto.rule_overrides ? JSON.stringify(dto.rule_overrides) : null,
       dto.points_rules ? JSON.stringify(dto.points_rules) : null, dto.is_public ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Tournament not found');
    return res.rows[0];
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
}
