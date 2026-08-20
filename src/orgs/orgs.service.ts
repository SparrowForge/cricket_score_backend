import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { JwtPayload } from '../auth/jwt-auth.guard';
import {
  ORG_ENUM_COLUMNS, ORG_JSON_COLUMNS, ORG_NUMBER_COLUMNS, ORG_TEXT_COLUMNS,
  OrgProfileDto,
} from './org-profile.dto';

/** Columns returned on the club list / directory cards. */
const ORG_CARD_COLUMNS = `o.id, o.name, o.slug, o.short_name, o.logo_url, o.banner_url,
       o.org_type, o.city, o.division, o.country, o.established_year, o.status,
       o.visibility, o.owner_user_id, o.created_at`;

@Injectable()
export class OrgsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Creates the org, owner membership, tournament_admin grant, and a free-plan subscription. */
  async create(user: JwtPayload, dto: { name: string; slug: string; logo_url?: string; city?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const org = (
        await client.query(
          `INSERT INTO organizations (name, slug, logo_url, city, owner_user_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (slug) DO NOTHING
           RETURNING *`,
          [dto.name, dto.slug, dto.logo_url ?? null, dto.city?.trim() || null, user.sub],
        )
      ).rows[0];
      if (!org) throw new ConflictException('Slug already taken');

      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, status, joined_at)
         VALUES ($1, $2, 'active', now())`,
        [org.id, user.sub],
      );
      await client.query(
        `INSERT INTO user_role_assignments (user_id, role_id, organization_id)
         SELECT $1, id, $2 FROM roles WHERE slug = 'tournament_admin' AND organization_id IS NULL
         ON CONFLICT DO NOTHING`,
        [user.sub, org.id],
      );
      const freePlan = (await client.query(`SELECT id, trial_days FROM subscription_plans WHERE slug = 'free'`)).rows[0];
      await client.query(
        `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_start, current_period_end)
         VALUES ($1, $2, 'active', now(), now() + interval '100 years')`,
        [org.id, freePlan.id],
      );
      await client.query('COMMIT');
      return org;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async mine(user: JwtPayload) {
    const res = await this.pool.query(
      `SELECT ${ORG_CARD_COLUMNS},
              (o.owner_user_id = $1) AS is_owner,
              p.slug AS plan
       FROM organizations o
       LEFT JOIN organization_members om ON om.organization_id = o.id AND om.user_id = $1 AND om.status = 'active'
       LEFT JOIN subscriptions s ON s.organization_id = o.id AND s.status IN ('trialing','active','past_due')
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE o.deleted_at IS NULL AND (o.owner_user_id = $1 OR om.user_id IS NOT NULL)
       ORDER BY o.created_at`,
      [user.sub],
    );
    return res.rows;
  }

  async get(id: string) {
    const res = await this.pool.query(
      `SELECT o.*, p.slug AS plan, p.features AS plan_features
       FROM organizations o
       LEFT JOIN subscriptions s ON s.organization_id = o.id AND s.status IN ('trialing','active','past_due')
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [id],
    );
    if (res.rowCount === 0) throw new NotFoundException('Organization not found');
    return res.rows[0];
  }

  /**
   * PATCH semantics, not PUT: only the keys actually sent are written. A key
   * sent as null (or '' for text) clears the column — which is why this builds
   * its SET list dynamically instead of `coalesce($n, col)`, where null can
   * only ever mean "leave alone" and a field could never be emptied.
   *
   * The five jsonb groups are replaced whole rather than merged, so the form
   * section that owns a group can drop a field by omitting it.
   */
  async update(
    id: string,
    dto: OrgProfileDto & { name?: string; logo_url?: string; settings?: object },
  ) {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (col: string, value: unknown, cast = '') => {
      values.push(value);
      sets.push(`${col} = $${values.length}${cast}`);
    };
    const record = dto as Record<string, unknown>;
    /** '' means "clear this" for a text field; null and '' both land as NULL. */
    const text = (v: unknown) => {
      const trimmed = typeof v === 'string' ? v.trim() : v;
      return trimmed === '' ? null : trimmed ?? null;
    };

    if (dto.name !== undefined) push('name', dto.name.trim());
    if (dto.logo_url !== undefined) push('logo_url', text(dto.logo_url));
    if (dto.settings !== undefined) push('settings', JSON.stringify(dto.settings), '::jsonb');

    for (const col of ORG_TEXT_COLUMNS) {
      if (record[col] !== undefined) push(col, text(record[col]));
    }
    for (const col of ORG_NUMBER_COLUMNS) {
      if (record[col] !== undefined) push(col, record[col] ?? null);
    }
    for (const [col, type] of Object.entries(ORG_ENUM_COLUMNS)) {
      if (record[col] !== undefined) push(col, record[col], `::${type}`);
    }
    for (const col of ORG_JSON_COLUMNS) {
      if (record[col] !== undefined) push(col, JSON.stringify(record[col] ?? {}), '::jsonb');
    }

    if (sets.length === 0) return this.get(id);

    const res = await this.pool.query(
      `UPDATE organizations SET ${sets.join(', ')}
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (res.rowCount === 0) throw new NotFoundException('Organization not found');
    return res.rows[0];
  }

  /** Soft-delete an org. Blocked while any match is in progress. */
  async softDelete(id: string) {
    const live = await this.pool.query(
      `SELECT count(*)::int AS n FROM matches
       WHERE organization_id = $1 AND status IN ('toss','live','innings_break','rain_delay')`,
      [id],
    );
    if (live.rows[0].n > 0) {
      throw new BadRequestException('Finish or abandon in-progress matches before deleting this organization');
    }
    const res = await this.pool.query(
      `UPDATE organizations SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id],
    );
    if (res.rowCount === 0) throw new NotFoundException('Organization not found');
    return { deleted: true };
  }

  async members(orgId: string) {
    const res = await this.pool.query(
      `SELECT u.id, u.email, u.full_name, u.avatar_url, om.status, om.joined_at,
              coalesce(array_agg(r.slug) FILTER (WHERE r.slug IS NOT NULL), '{}') AS org_roles
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       LEFT JOIN user_role_assignments ura ON ura.user_id = u.id AND ura.organization_id = om.organization_id
       LEFT JOIN roles r ON r.id = ura.role_id
       WHERE om.organization_id = $1 AND om.status <> 'removed'
       GROUP BY u.id, om.status, om.joined_at
       ORDER BY om.joined_at NULLS LAST`,
      [orgId],
    );
    return res.rows;
  }

  /** Registered-user autocomplete for the add-member form (owner-gated at the controller). */
  async userSearch(q: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    const res = await this.pool.query(
      `SELECT id, email, full_name FROM users
       WHERE deleted_at IS NULL AND (email ILIKE $1 OR full_name ILIKE $1)
       ORDER BY email LIMIT 10`,
      [`%${term}%`],
    );
    return res.rows;
  }

  /** Add an existing user (by email) as a member with a role (scorer/commentator/tournament_admin/viewer). */
  async addMember(orgId: string, dto: { email: string; role: string }, invitedBy: string) {
    const user = (await this.pool.query(`SELECT id, full_name FROM users WHERE email = $1 AND deleted_at IS NULL`, [dto.email])).rows[0];
    if (!user) throw new NotFoundException('No user with that email — they must register first');

    await this.pool.query(
      `INSERT INTO organization_members (organization_id, user_id, status, invited_by, joined_at)
       VALUES ($1, $2, 'active', $3, now())
       ON CONFLICT (organization_id, user_id) DO UPDATE SET status = 'active'`,
      [orgId, user.id, invitedBy],
    );
    await this.pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, organization_id, granted_by)
       SELECT $1, id, $2, $3 FROM roles WHERE slug = $4 AND organization_id IS NULL
       ON CONFLICT DO NOTHING`,
      [user.id, orgId, invitedBy, dto.role],
    );
    return { added: true, user_id: user.id, full_name: user.full_name };
  }

  async removeMember(orgId: string, userId: string) {
    await this.pool.query(
      `UPDATE organization_members SET status = 'removed' WHERE organization_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    await this.pool.query(
      `DELETE FROM user_role_assignments WHERE user_id = $2 AND organization_id = $1`,
      [orgId, userId],
    );
    return { removed: true };
  }

  /* ================= Public club directory =================
   * Unauthenticated. Only active + public clubs are visible; `visibility`
   * hides the club itself, never its matches (those follow their tournament).
   */

  /** Directory listing, newest-first, with optional text / city / country / type filters. */
  async publicList(opts: { q?: string; city?: string; country?: string; type?: string; limit: number; offset: number }) {
    const where = [`o.deleted_at IS NULL`, `o.status = 'active'`, `o.visibility = 'public'`];
    const values: unknown[] = [];
    const bind = (v: unknown) => `$${values.push(v)}`;

    const q = opts.q?.trim();
    if (q) {
      const like = bind(`%${q}%`);
      where.push(`(o.name ILIKE ${like} OR o.short_name ILIKE ${like} OR o.city ILIKE ${like})`);
    }
    if (opts.city?.trim()) where.push(`lower(o.city) = lower(${bind(opts.city.trim())})`);
    if (opts.country?.trim()) where.push(`lower(o.country) = lower(${bind(opts.country.trim())})`);
    if (opts.type) where.push(`o.org_type = ${bind(opts.type)}::org_type`);

    const res = await this.pool.query(
      `SELECT ${ORG_CARD_COLUMNS.replace('o.owner_user_id, ', '')}
       FROM organizations o
       WHERE ${where.join(' AND ')}
       ORDER BY o.name
       LIMIT ${bind(opts.limit)} OFFSET ${bind(opts.offset)}`,
      values,
    );
    return res.rows;
  }

  /** Distinct cities that actually have a listed club — populates the filter. */
  async publicCities() {
    const res = await this.pool.query(
      `SELECT o.city, count(*)::int AS clubs
       FROM organizations o
       WHERE o.deleted_at IS NULL AND o.status = 'active' AND o.visibility = 'public'
         AND o.city IS NOT NULL AND o.city <> ''
       GROUP BY o.city ORDER BY clubs DESC, o.city`,
    );
    return res.rows;
  }

  /**
   * Public club profile by slug. Deliberately does not select `settings`,
   * `owner_user_id` or the plan — those are tenant internals, not profile.
   */
  async publicProfile(slug: string) {
    const res = await this.pool.query(
      `SELECT o.id, o.name, o.slug, o.short_name, o.logo_url, o.banner_url,
              o.org_type, o.established_year, o.description,
              o.country, o.division, o.city, o.address_line, o.postal_code,
              o.latitude, o.longitude, o.home_ground,
              o.contact_name, o.contact_designation, o.contact_phone,
              o.contact_phone_alt, o.contact_email, o.website_url,
              o.registration - 'tax_id' AS registration,
              o.cricket_details, o.facilities, o.achievements, o.social,
              o.created_at,
              (SELECT count(*)::int FROM teams t
                WHERE t.organization_id = o.id AND t.deleted_at IS NULL AND NOT t.is_synthetic) AS team_count,
              (SELECT count(*)::int FROM players pl
                WHERE pl.organization_id = o.id AND pl.deleted_at IS NULL) AS player_count,
              (SELECT count(*)::int FROM tournaments tr
                WHERE tr.organization_id = o.id AND tr.deleted_at IS NULL AND tr.is_public) AS tournament_count,
              (SELECT count(*)::int FROM matches m
                WHERE m.organization_id = o.id AND m.status = 'completed') AS matches_played
       FROM organizations o
       WHERE o.slug = $1 AND o.deleted_at IS NULL
         AND o.status = 'active' AND o.visibility = 'public'`,
      [slug],
    );
    if (res.rowCount === 0) throw new NotFoundException('Club not found');
    return res.rows[0];
  }
}
