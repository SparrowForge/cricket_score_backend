import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

/**
 * Scoped RBAC guard.
 *   @RequirePermission('scoring', 'score')
 * Scope precedence: match > tournament > organization > global.
 * Resolved permission sets are cached in Redis for 60s and busted on any
 * role/assignment mutation (RoleService deletes perms:{userId}:*).
 */
export const RequirePermission = (resource: string, action: string) =>
  SetMetadata('perm', { resource, action });

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: Redis,
    private readonly db: DataSource,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const perm = this.reflector.getAllAndOverride<{ resource: string; action: string }>('perm', [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!perm) return true;

    const req = ctx.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.id;
    if (!userId) return false;

    // Scope is inferred from route params; match implies its tournament/org.
    const scope = {
      matchId: req.params.matchId ?? req.params.id_if_match ?? null,
      tournamentId: req.params.tournamentId ?? null,
      orgId: req.params.orgId ?? null,
    };

    const grants = await this.resolveGrants(userId);
    const key = `${perm.resource}:${perm.action}`;

    return grants.some((g) =>
      g.perms.has(key) &&
      (g.matchId === null || g.matchId === scope.matchId) &&
      (g.tournamentId === null || g.tournamentId === scope.tournamentId || g.matchId !== null) &&
      (g.orgId === null || g.orgId === scope.orgId || g.tournamentId !== null || g.matchId !== null),
    );
  }

  private async resolveGrants(userId: string) {
    const cacheKey = `perms:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return this.hydrate(JSON.parse(cached));

    const rows = await this.db.query(
      `SELECT ura.organization_id AS org_id, ura.tournament_id, ura.match_id,
              array_agg(p.resource || ':' || p.action) AS perms
       FROM user_role_assignments ura
       JOIN role_permissions rp ON rp.role_id = ura.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1 AND (ura.expires_at IS NULL OR ura.expires_at > now())
       GROUP BY 1, 2, 3`,
      [userId],
    );
    await this.redis.set(cacheKey, JSON.stringify(rows), 'EX', 60);
    return this.hydrate(rows);
  }

  private hydrate(rows: any[]) {
    return rows.map((r) => ({
      orgId: r.org_id, tournamentId: r.tournament_id, matchId: r.match_id,
      perms: new Set<string>(r.perms),
    }));
  }
}
