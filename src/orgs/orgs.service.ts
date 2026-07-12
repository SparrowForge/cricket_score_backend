import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { JwtPayload } from '../auth/jwt-auth.guard';

@Injectable()
export class OrgsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Creates the org, owner membership, tournament_admin grant, and a free-plan subscription. */
  async create(user: JwtPayload, dto: { name: string; slug: string; logo_url?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const org = (
        await client.query(
          `INSERT INTO organizations (name, slug, logo_url, owner_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (slug) DO NOTHING
           RETURNING *`,
          [dto.name, dto.slug, dto.logo_url ?? null, user.sub],
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
      `SELECT o.id, o.name, o.slug, o.logo_url, o.owner_user_id, o.created_at,
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

  async update(id: string, dto: { name?: string; logo_url?: string; settings?: object }) {
    const res = await this.pool.query(
      `UPDATE organizations SET
         name = coalesce($2, name),
         logo_url = coalesce($3, logo_url),
         settings = coalesce($4, settings)
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, dto.name ?? null, dto.logo_url ?? null, dto.settings ? JSON.stringify(dto.settings) : null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Organization not found');
    return res.rows[0];
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
}
