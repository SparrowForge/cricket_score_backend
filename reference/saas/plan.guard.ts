import { CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

/**
 * Subscription entitlement enforcement.
 *
 *   @RequiresFeature('dls')                 // boolean feature flag on the plan
 *   @RequiresQuota('max_tournaments', TournamentCounter)  // numeric limit
 *
 * Over-limit responses are 402 with a machine-readable upgrade hint that
 * web/mobile render as an upgrade prompt.
 */
export const RequiresFeature = (feature: string) => SetMetadata('planFeature', feature);
export const RequiresQuota = (limit: string, counterToken: string) =>
  SetMetadata('planQuota', { limit, counterToken });

@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: Redis,
    private readonly db: DataSource,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.get<string>('planFeature', ctx.getHandler());
    const quota = this.reflector.get<{ limit: string; counterToken: string }>('planQuota', ctx.getHandler());
    if (!feature && !quota) return true;

    const req = ctx.switchToHttp().getRequest();
    const orgId = req.params.orgId ?? req.tenantOrgId;
    const features = await this.getPlanFeatures(orgId);

    if (feature && features[feature] !== true) {
      throw new HttpException({
        code: 'PLAN_LIMIT', feature,
        message: `Your plan does not include ${feature}`,
        upgrade_url: '/pricing',
      }, 402);
    }

    if (quota) {
      const limit = features[quota.limit]; // null = unlimited
      if (limit !== null && limit !== undefined) {
        const used = await this.count(quota.counterToken, orgId);
        if (used >= limit) {
          throw new HttpException({
            code: 'PLAN_LIMIT', feature: quota.limit, used, limit,
            message: `Plan limit reached (${used}/${limit})`,
            upgrade_url: '/pricing',
          }, 402);
        }
      }
    }
    return true;
  }

  /** Active plan features, cached 5 min; SubscriptionService busts on change. */
  private async getPlanFeatures(orgId: string): Promise<Record<string, any>> {
    const key = `plan:features:${orgId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);

    const rows = await this.db.query(
      `SELECT p.features FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.organization_id = $1 AND s.status IN ('trialing','active','past_due')
       LIMIT 1`,
      [orgId],
    );
    // No subscription row → free-plan defaults
    const features = rows[0]?.features
      ?? (await this.db.query(`SELECT features FROM subscription_plans WHERE slug='free'`))[0].features;

    await this.redis.set(key, JSON.stringify(features), 'EX', 300);
    return features;
  }

  private count(counterToken: string, orgId: string): Promise<number> {
    const sql: Record<string, string> = {
      tournaments: `SELECT count(*) FROM tournaments WHERE organization_id=$1 AND deleted_at IS NULL AND status <> 'archived'`,
      teams: `SELECT count(*) FROM teams WHERE organization_id=$1 AND deleted_at IS NULL`,
      concurrent_matches: `SELECT count(*) FROM matches WHERE organization_id=$1 AND status IN ('live','innings_break','rain_delay','toss')`,
    };
    return this.db.query(sql[counterToken], [orgId]).then((r) => Number(r[0].count));
  }
}
