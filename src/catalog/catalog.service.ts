import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class CatalogService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---------- Formats ----------
  async formats(orgId?: string) {
    const res = await this.pool.query(
      `SELECT id, organization_id, name, slug, version, is_builtin, rules
       FROM match_formats
       WHERE organization_id IS NULL OR organization_id = $1
       ORDER BY is_builtin DESC, name`,
      [orgId ?? null],
    );
    return res.rows;
  }

  async createFormat(orgId: string, dto: { name: string; slug: string; rules: object }) {
    const res = await this.pool.query(
      `INSERT INTO match_formats (organization_id, name, slug, rules)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, slug, version) DO NOTHING RETURNING *`,
      [orgId, dto.name, dto.slug, JSON.stringify(dto.rules)],
    );
    if (res.rowCount === 0) throw new ConflictException('Format slug/version already exists');
    return res.rows[0];
  }

  // ---------- Venues ----------
  async venues(orgId: string) {
    return (
      await this.pool.query(
        `SELECT * FROM venues WHERE organization_id = $1 OR organization_id IS NULL ORDER BY name`,
        [orgId],
      )
    ).rows;
  }

  async createVenue(orgId: string, dto: any) {
    const res = await this.pool.query(
      `INSERT INTO venues (organization_id, name, city, country, capacity, image_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, dto.name, dto.city ?? null, dto.country ?? null, dto.capacity ?? null, dto.image_url ?? null],
    );
    return res.rows[0];
  }

  async updateVenue(id: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE venues SET name = coalesce($2,name), city = coalesce($3,city), country = coalesce($4,country),
              capacity = coalesce($5,capacity), image_url = coalesce($6,image_url)
       WHERE id = $1 RETURNING *`,
      [id, dto.name ?? null, dto.city ?? null, dto.country ?? null, dto.capacity ?? null, dto.image_url ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Venue not found');
    return res.rows[0];
  }

  async deleteVenue(id: string) {
    // Detach from teams/matches that reference it so the delete is safe.
    await this.pool.query(`UPDATE teams SET home_venue_id = NULL WHERE home_venue_id = $1`, [id]);
    await this.pool.query(`UPDATE matches SET venue_id = NULL WHERE venue_id = $1`, [id]);
    const res = await this.pool.query(`DELETE FROM venues WHERE id = $1 RETURNING id`, [id]);
    if (res.rowCount === 0) throw new NotFoundException('Venue not found');
    return { deleted: true };
  }

  async orgIdOfVenue(venueId: string): Promise<string> {
    const r = await this.pool.query(`SELECT organization_id FROM venues WHERE id = $1`, [venueId]);
    if (r.rowCount === 0) throw new NotFoundException('Venue not found');
    if (!r.rows[0].organization_id) throw new NotFoundException('Built-in venue cannot be modified');
    return r.rows[0].organization_id;
  }

  // ---------- Officials (umpires / referees / scorers) ----------
  async officials(orgId: string) {
    return (
      await this.pool.query(
        `SELECT * FROM officials WHERE organization_id = $1 OR organization_id IS NULL ORDER BY full_name`,
        [orgId],
      )
    ).rows;
  }

  async createOfficial(orgId: string, dto: { full_name: string; official_type: string; photo_url?: string }) {
    const res = await this.pool.query(
      `INSERT INTO officials (organization_id, full_name, official_type, photo_url)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [orgId, dto.full_name, dto.official_type, dto.photo_url ?? null],
    );
    return res.rows[0];
  }

  async updateOfficial(id: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE officials SET full_name = coalesce($2,full_name), official_type = coalesce($3,official_type),
              photo_url = coalesce($4,photo_url)
       WHERE id = $1 RETURNING *`,
      [id, dto.full_name ?? null, dto.official_type ?? null, dto.photo_url ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Official not found');
    return res.rows[0];
  }

  async deleteOfficial(id: string) {
    await this.pool.query(`DELETE FROM officials WHERE id = $1`, [id]);
    return { deleted: true };
  }

  // ---------- Team stats ----------
  async teamStats(teamId: string) {
    const overall = (
      await this.pool.query(
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS played,
                count(*) FILTER (WHERE winner_team_id = $1)::int AS won,
                count(*) FILTER (WHERE status = 'completed' AND result_type = 'win' AND winner_team_id <> $1)::int AS lost,
                count(*) FILTER (WHERE result_type = 'tie')::int AS tied,
                count(*) FILTER (WHERE result_type IN ('no_result','abandoned'))::int AS no_results
         FROM matches WHERE (team_a_id = $1 OR team_b_id = $1) AND status IN ('completed','abandoned','no_result')`,
        [teamId],
      )
    ).rows[0];
    const totals = (
      await this.pool.query(
        `SELECT max(total_runs)::int AS highest_total, min(total_runs)::int AS lowest_total,
                round(avg(total_runs), 1) AS avg_total
         FROM innings i JOIN matches m ON m.id = i.match_id
         WHERE i.batting_team_id = $1 AND m.status = 'completed' AND i.status IN ('completed','declared')`,
        [teamId],
      )
    ).rows[0];
    const form = (
      await this.pool.query(
        `SELECT id, result_summary, scheduled_start,
                CASE WHEN winner_team_id = $1 THEN 'W'
                     WHEN result_type = 'tie' THEN 'T'
                     WHEN result_type IN ('no_result','abandoned') THEN 'NR'
                     ELSE 'L' END AS outcome
         FROM matches WHERE (team_a_id = $1 OR team_b_id = $1) AND status IN ('completed','abandoned','no_result')
         ORDER BY completed_at DESC NULLS LAST LIMIT 5`,
        [teamId],
      )
    ).rows;
    return { ...overall, ...totals, recent_form: form };
  }

  // ---------- Teams ----------
  async teams(orgId: string) {
    return (
      await this.pool.query(
        `SELECT t.*, v.name AS home_venue,
                (SELECT count(*)::int FROM team_players tp WHERE tp.team_id = t.id AND tp.active_to IS NULL) AS squad_size
         FROM teams t LEFT JOIN venues v ON v.id = t.home_venue_id
         WHERE t.organization_id = $1 AND t.deleted_at IS NULL ORDER BY t.name`,
        [orgId],
      )
    ).rows;
  }

  async createTeam(orgId: string, dto: any) {
    const res = await this.pool.query(
      `INSERT INTO teams (organization_id, name, short_name, slug, logo_url, primary_color, home_venue_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, slug) DO NOTHING RETURNING *`,
      [orgId, dto.name, dto.short_name.toUpperCase(), dto.slug, dto.logo_url ?? null,
       dto.primary_color ?? null, dto.home_venue_id ?? null],
    );
    if (res.rowCount === 0) throw new ConflictException('Team slug already exists in this organization');
    return res.rows[0];
  }

  async team(teamId: string) {
    const team = (
      await this.pool.query(
        `SELECT t.*, v.name AS home_venue FROM teams t
         LEFT JOIN venues v ON v.id = t.home_venue_id
         WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [teamId],
      )
    ).rows[0];
    if (!team) throw new NotFoundException('Team not found');
    team.squad = (
      await this.pool.query(
        `SELECT p.id, p.full_name, p.primary_role, p.batting_style, p.bowling_style, p.photo_url,
                tp.jersey_number, tp.is_captain, tp.is_wicket_keeper
         FROM team_players tp JOIN players p ON p.id = tp.player_id
         WHERE tp.team_id = $1 AND tp.active_to IS NULL
         ORDER BY tp.jersey_number NULLS LAST, p.full_name`,
        [teamId],
      )
    ).rows;
    return team;
  }

  async updateTeam(teamId: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE teams SET name = coalesce($2,name), short_name = coalesce($3,short_name),
              logo_url = coalesce($4,logo_url), primary_color = coalesce($5,primary_color),
              home_venue_id = coalesce($6,home_venue_id)
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [teamId, dto.name ?? null, dto.short_name?.toUpperCase() ?? null, dto.logo_url ?? null,
       dto.primary_color ?? null, dto.home_venue_id ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Team not found');
    return res.rows[0];
  }

  async deleteTeam(teamId: string) {
    await this.pool.query(`UPDATE teams SET deleted_at = now() WHERE id = $1`, [teamId]);
    return { deleted: true };
  }

  async addTeamPlayer(teamId: string, dto: any) {
    const res = await this.pool.query(
      `INSERT INTO team_players (team_id, player_id, jersey_number, is_captain, is_wicket_keeper)
       VALUES ($1,$2,$3, coalesce($4,false), coalesce($5,false))
       ON CONFLICT (team_id, player_id, active_from) DO UPDATE
         SET jersey_number = excluded.jersey_number, is_captain = excluded.is_captain,
             is_wicket_keeper = excluded.is_wicket_keeper, active_to = NULL
       RETURNING *`,
      [teamId, dto.player_id, dto.jersey_number ?? null, dto.is_captain, dto.is_wicket_keeper],
    );
    return res.rows[0];
  }

  async removeTeamPlayer(teamId: string, playerId: string) {
    await this.pool.query(
      `UPDATE team_players SET active_to = CURRENT_DATE WHERE team_id = $1 AND player_id = $2 AND active_to IS NULL`,
      [teamId, playerId],
    );
    return { removed: true };
  }

  // ---------- Players ----------
  async players(orgId: string, search?: string) {
    return (
      await this.pool.query(
        `SELECT * FROM players
         WHERE organization_id = $1 AND deleted_at IS NULL
           AND ($2::text IS NULL OR full_name ILIKE '%' || $2 || '%')
         ORDER BY full_name LIMIT 200`,
        [orgId, search ?? null],
      )
    ).rows;
  }

  async createPlayer(orgId: string, dto: any) {
    const res = await this.pool.query(
      `INSERT INTO players (organization_id, full_name, display_name, date_of_birth,
                            batting_style, bowling_style, primary_role, photo_url, country,
                            height_cm, major_teams, bio)
       VALUES ($1,$2,$3,$4,$5::batting_style, coalesce($6,'none')::bowling_style, coalesce($7,'batter')::player_role, $8, $9,
               $10, coalesce($11::text[],'{}'::text[]), $12) RETURNING *`,
      [orgId, dto.full_name, dto.display_name ?? null, dto.date_of_birth ?? null,
       dto.batting_style ?? null, dto.bowling_style, dto.primary_role, dto.photo_url ?? null, dto.country ?? null,
       dto.height_cm ?? null, dto.major_teams ?? null, dto.bio ?? null],
    );
    return res.rows[0];
  }

  /** Full profile: bio fields, career stats, recent matches, and current team affiliations. */
  async player(playerId: string) {
    const p = (await this.pool.query(`SELECT * FROM players WHERE id = $1 AND deleted_at IS NULL`, [playerId])).rows[0];
    if (!p) throw new NotFoundException('Player not found');
    p.career_stats = (
      await this.pool.query(`SELECT * FROM player_career_stats WHERE player_id = $1`, [playerId])
    ).rows;
    p.recent_matches = (
      await this.pool.query(
        `SELECT pms.match_id, pms.runs_scored, pms.balls_faced, pms.wickets_taken, pms.runs_conceded,
                m.scheduled_start, m.result_summary
         FROM player_match_stats pms JOIN matches m ON m.id = pms.match_id
         WHERE pms.player_id = $1 ORDER BY m.scheduled_start DESC LIMIT 10`,
        [playerId],
      )
    ).rows;
    p.teams = (
      await this.pool.query(
        `SELECT t.id, t.name, t.short_name, t.logo_url
         FROM team_players tp JOIN teams t ON t.id = tp.team_id
         WHERE tp.player_id = $1 AND tp.active_to IS NULL AND t.deleted_at IS NULL
         ORDER BY t.name`,
        [playerId],
      )
    ).rows;
    return p;
  }

  /** Global, unauthenticated search across every organization's roster (public profile browsing). */
  async publicSearch(search?: string, limit = 20) {
    return (
      await this.pool.query(
        `SELECT p.id, p.full_name, p.display_name, p.primary_role, p.photo_url, p.country,
                p.date_of_birth, p.height_cm, p.major_teams
         FROM players p
         JOIN organizations o ON o.id = p.organization_id AND o.deleted_at IS NULL
         WHERE p.deleted_at IS NULL
           AND ($1::text IS NULL OR p.full_name ILIKE '%' || $1 || '%')
         ORDER BY p.full_name LIMIT $2`,
        [search ?? null, Math.min(limit, 50)],
      )
    ).rows;
  }

  /** Overall (career, cross-tournament) leaderboards: Most Runs / Most Wickets / MVP. */
  async playerLeaders(limit = 15) {
    const lim = Math.min(limit, 50);
    // Most-recent team a player turned out for, shown next to their name.
    const lastTeam = `(
      SELECT tm.short_name FROM player_match_stats pms2
      JOIN matches m2 ON m2.id = pms2.match_id
      JOIN teams tm ON tm.id = pms2.team_id
      WHERE pms2.player_id = p.id
      ORDER BY m2.completed_at DESC NULLS LAST LIMIT 1
    )`;
    const runs = (
      await this.pool.query(
        `SELECT p.id AS player_id, p.full_name, p.photo_url, ${lastTeam} AS team_short_name,
                sum(pcs.matches_played)::int AS matches_played,
                sum(pcs.runs_scored)::int AS runs_scored,
                max(pcs.highest_score)::int AS highest_score,
                CASE WHEN sum(pcs.balls_faced) > 0
                     THEN round(sum(pcs.runs_scored)::numeric * 100 / sum(pcs.balls_faced), 1) END AS strike_rate
         FROM player_career_stats pcs JOIN players p ON p.id = pcs.player_id
         WHERE p.deleted_at IS NULL
         GROUP BY p.id, p.full_name, p.photo_url
         HAVING sum(pcs.runs_scored) > 0
         ORDER BY runs_scored DESC, strike_rate DESC NULLS LAST LIMIT $1`,
        [lim],
      )
    ).rows;
    const wickets = (
      await this.pool.query(
        `SELECT p.id AS player_id, p.full_name, p.photo_url, ${lastTeam} AS team_short_name,
                sum(pcs.matches_played)::int AS matches_played,
                sum(pcs.wickets_taken)::int AS wickets_taken,
                CASE WHEN sum(pcs.balls_bowled) > 0
                     THEN round(sum(pcs.runs_conceded)::numeric * 6 / sum(pcs.balls_bowled), 2) END AS economy
         FROM player_career_stats pcs JOIN players p ON p.id = pcs.player_id
         WHERE p.deleted_at IS NULL
         GROUP BY p.id, p.full_name, p.photo_url
         HAVING sum(pcs.wickets_taken) > 0
         ORDER BY wickets_taken DESC, economy ASC NULLS LAST LIMIT $1`,
        [lim],
      )
    ).rows;
    const mvp = (
      await this.pool.query(
        `SELECT p.id AS player_id, p.full_name, p.photo_url, ${lastTeam} AS team_short_name,
                count(*)::int AS matches_played,
                -- A negative career total is shown as 0, but the ranking uses the
                -- real figure so two players sitting on 0 still order by how far
                -- below they actually are.
                round(greatest(sum(pms.mvp_points), 0), 2) AS mvp_points
         FROM player_match_stats pms JOIN players p ON p.id = pms.player_id
         WHERE p.deleted_at IS NULL AND pms.mvp_points IS NOT NULL
         GROUP BY p.id, p.full_name, p.photo_url
         HAVING sum(pms.mvp_points) > 0
         ORDER BY sum(pms.mvp_points) DESC LIMIT $1`,
        [lim],
      )
    ).rows;
    return { runs, wickets, mvp };
  }

  async updatePlayer(playerId: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE players SET full_name = coalesce($2,full_name), display_name = coalesce($3,display_name),
              date_of_birth = coalesce($4,date_of_birth), batting_style = coalesce($5::batting_style,batting_style),
              bowling_style = coalesce($6::bowling_style,bowling_style), primary_role = coalesce($7::player_role,primary_role),
              photo_url = coalesce($8,photo_url), country = coalesce($9,country),
              height_cm = coalesce($10,height_cm), major_teams = coalesce($11::text[],major_teams), bio = coalesce($12,bio)
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [playerId, dto.full_name ?? null, dto.display_name ?? null, dto.date_of_birth ?? null,
       dto.batting_style ?? null, dto.bowling_style ?? null, dto.primary_role ?? null,
       dto.photo_url ?? null, dto.country ?? null,
       dto.height_cm ?? null, dto.major_teams ?? null, dto.bio ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Player not found');
    return res.rows[0];
  }

  async deletePlayer(playerId: string) {
    await this.pool.query(`UPDATE players SET deleted_at = now() WHERE id = $1`, [playerId]);
    return { deleted: true };
  }

  async orgIdOfTeam(teamId: string): Promise<string> {
    const r = await this.pool.query(`SELECT organization_id FROM teams WHERE id = $1`, [teamId]);
    if (r.rowCount === 0) throw new NotFoundException('Team not found');
    return r.rows[0].organization_id;
  }

  async orgIdOfPlayer(playerId: string): Promise<string> {
    const r = await this.pool.query(`SELECT organization_id FROM players WHERE id = $1`, [playerId]);
    if (r.rowCount === 0) throw new NotFoundException('Player not found');
    return r.rows[0].organization_id;
  }
}
