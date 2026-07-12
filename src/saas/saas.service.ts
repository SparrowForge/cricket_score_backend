import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

const QUOTA_COUNTS: Record<string, string> = {
  max_tournaments: `SELECT count(*)::int AS n FROM tournaments
                    WHERE organization_id = $1 AND deleted_at IS NULL AND status NOT IN ('archived','cancelled')`,
  max_teams: `SELECT count(*)::int AS n FROM teams WHERE organization_id = $1 AND deleted_at IS NULL`,
  max_concurrent_matches: `SELECT count(*)::int AS n FROM matches
                           WHERE organization_id = $1 AND status IN ('toss','live','innings_break','rain_delay')`,
};

@Injectable()
export class SaasService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---------- Plans ----------
  async publicPlans() {
    const res = await this.pool.query(
      `SELECT id, slug, name, description, price_cents, currency, billing_interval, trial_days, features, sort_order
       FROM subscription_plans WHERE is_active AND is_public ORDER BY sort_order`,
    );
    return res.rows;
  }

  async allPlans() {
    return (await this.pool.query(`SELECT * FROM subscription_plans ORDER BY sort_order`)).rows;
  }

  async createPlan(dto: any) {
    const res = await this.pool.query(
      `INSERT INTO subscription_plans (slug, name, description, price_cents, currency, billing_interval,
                                       trial_days, features, is_active, is_public, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9, true), coalesce($10, true), coalesce($11, 0))
       RETURNING *`,
      [dto.slug, dto.name, dto.description ?? null, dto.price_cents, dto.currency ?? 'USD',
       dto.billing_interval ?? 'month', dto.trial_days ?? 0, JSON.stringify(dto.features ?? {}),
       dto.is_active, dto.is_public, dto.sort_order],
    );
    return res.rows[0];
  }

  async updatePlan(id: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE subscription_plans SET
         name = coalesce($2, name), description = coalesce($3, description),
         price_cents = coalesce($4, price_cents), currency = coalesce($5, currency),
         billing_interval = coalesce($6, billing_interval), trial_days = coalesce($7, trial_days),
         features = coalesce($8, features), is_active = coalesce($9, is_active),
         is_public = coalesce($10, is_public), sort_order = coalesce($11, sort_order)
       WHERE id = $1 RETURNING *`,
      [id, dto.name ?? null, dto.description ?? null, dto.price_cents ?? null, dto.currency ?? null,
       dto.billing_interval ?? null, dto.trial_days ?? null,
       dto.features ? JSON.stringify(dto.features) : null,
       dto.is_active ?? null, dto.is_public ?? null, dto.sort_order ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Plan not found');
    return res.rows[0];
  }

  async retirePlan(id: string) {
    const res = await this.pool.query(
      `UPDATE subscription_plans SET is_active = false, is_public = false WHERE id = $1 RETURNING id`,
      [id],
    );
    if (res.rowCount === 0) throw new NotFoundException('Plan not found');
    return { retired: true };
  }

  // ---------- Subscriptions ----------
  async orgSubscription(orgId: string) {
    const res = await this.pool.query(
      `SELECT s.*, p.slug AS plan_slug, p.name AS plan_name, p.features, p.price_cents, p.currency, p.billing_interval
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.organization_id = $1 AND s.status IN ('trialing','active','past_due')`,
      [orgId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Change plan. Payment-gateway-ready: paid plans start 'trialing' for trial_days
   * (or 'active' immediately for free). When a gateway is wired in, this is where
   * checkout creation happens.
   */
  async changePlan(orgId: string, planId: string) {
    const plan = (await this.pool.query(`SELECT * FROM subscription_plans WHERE id = $1 AND is_active`, [planId])).rows[0];
    if (!plan) throw new BadRequestException('Unknown or inactive plan');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now()
         WHERE organization_id = $1 AND status IN ('trialing','active','past_due')`,
        [orgId],
      );
      const status = plan.price_cents === 0 ? 'active' : plan.trial_days > 0 ? 'trialing' : 'active';
      const periodEnd =
        plan.price_cents === 0
          ? `now() + interval '100 years'`
          : plan.trial_days > 0
            ? `now() + interval '${Number(plan.trial_days)} days'`
            : plan.billing_interval === 'year'
              ? `now() + interval '1 year'`
              : `now() + interval '1 month'`;
      const sub = (
        await client.query(
          `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_start, current_period_end)
           VALUES ($1, $2, $3, now(), ${periodEnd}) RETURNING *`,
          [orgId, planId, status],
        )
      ).rows[0];
      await client.query('COMMIT');
      return sub;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async cancel(orgId: string) {
    const res = await this.pool.query(
      `UPDATE subscriptions SET cancel_at_period_end = true
       WHERE organization_id = $1 AND status IN ('trialing','active','past_due') RETURNING *`,
      [orgId],
    );
    if (res.rowCount === 0) throw new NotFoundException('No active subscription');
    return res.rows[0];
  }

  /** Entitlements for the org's active plan — used by clients to gate UI. */
  async entitlements(orgId: string) {
    const sub = await this.orgSubscription(orgId);
    if (sub) return sub.features;
    return (await this.pool.query(`SELECT features FROM subscription_plans WHERE slug = 'free'`)).rows[0].features;
  }

  /**
   * Enforce a numeric plan limit before a creating action.
   * null / missing limit = unlimited. Over-limit → 402 PLAN_LIMIT with upgrade hint.
   */
  async assertQuota(orgId: string, feature: keyof typeof QUOTA_COUNTS): Promise<void> {
    const ent = await this.entitlements(orgId);
    const limit = ent?.[feature];
    if (limit === null || limit === undefined) return; // unlimited
    const used = (await this.pool.query(QUOTA_COUNTS[feature], [orgId])).rows[0].n;
    if (used >= limit) {
      throw new HttpException(
        {
          code: 'PLAN_LIMIT', feature, used, limit,
          message: `Your plan allows ${limit} ${feature.replace('max_', '').replace(/_/g, ' ')} (currently ${used}). Upgrade to continue.`,
          upgrade_url: '/pricing',
        },
        402,
      );
    }
  }

  /** Boolean feature gate (e.g. 'dls', 'commentary') → 402 when the plan lacks it. */
  async assertFeature(orgId: string, feature: string): Promise<void> {
    const ent = await this.entitlements(orgId);
    if (ent?.[feature] !== true) {
      throw new HttpException(
        { code: 'PLAN_LIMIT', feature, message: `Your plan does not include ${feature}`, upgrade_url: '/pricing' },
        402,
      );
    }
  }
}
