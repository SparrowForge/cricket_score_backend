import {
  CanActivate, createParamDecorator, ExecutionContext, ForbiddenException,
  Inject, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { JwtPayload } from '../auth/jwt-auth.guard';

/** Route-level role gate: @Roles('tournament_admin'). super_admin always passes. */
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => ctx.switchToHttp().getRequest().user,
);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const user: JwtPayload | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) return false;
    if (user.roles.includes('super_admin')) return true;
    if (required.some((r) => user.roles.includes(r))) return true;
    throw new ForbiddenException(`Requires role: ${required.join(' or ')}`);
  }
}

/**
 * Data-scoped access checks (org membership, match scorer grants).
 * Complements the JWT role gate with row-level authorization.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  isSuperAdmin(user: JwtPayload): boolean {
    return user.roles.includes('super_admin');
  }

  /** User must be an active member of the org (owner/admin implied by membership here). */
  async assertOrgMember(orgId: string, user: JwtPayload): Promise<void> {
    if (this.isSuperAdmin(user)) return;
    const res = await this.pool.query(
      `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'
       UNION SELECT 1 FROM organizations WHERE id = $1 AND owner_user_id = $2`,
      [orgId, user.sub],
    );
    if (res.rowCount === 0) throw new ForbiddenException('Not a member of this organization');
  }

  async assertOrgOwner(orgId: string, user: JwtPayload): Promise<void> {
    if (this.isSuperAdmin(user)) return;
    const res = await this.pool.query(
      `SELECT 1 FROM organizations WHERE id = $1 AND owner_user_id = $2`,
      [orgId, user.sub],
    );
    if (res.rowCount === 0) throw new ForbiddenException('Only the organization owner can do this');
  }

  /** Scoring rights: match-scoped scorer grant, or member of the owning org, or super admin. */
  async assertCanScore(matchId: string, user: JwtPayload): Promise<void> {
    if (this.isSuperAdmin(user)) return;
    const res = await this.pool.query(
      `SELECT 1 FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
        WHERE ura.user_id = $2 AND ura.match_id = $1 AND r.slug IN ('scorer','tournament_admin')
          AND (ura.expires_at IS NULL OR ura.expires_at > now())
       UNION
       SELECT 1 FROM matches m
         JOIN organization_members om ON om.organization_id = m.organization_id
        WHERE m.id = $1 AND om.user_id = $2 AND om.status = 'active'
       UNION
       SELECT 1 FROM matches m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.id = $1 AND o.owner_user_id = $2`,
      [matchId, user.sub],
    );
    if (res.rowCount === 0) throw new ForbiddenException('No scoring access for this match');
  }

  /** Resolve a match's org and assert membership (for match admin ops). */
  async assertMatchOrgMember(matchId: string, user: JwtPayload): Promise<string> {
    const m = await this.pool.query(`SELECT organization_id FROM matches WHERE id = $1`, [matchId]);
    if (m.rowCount === 0) throw new ForbiddenException('Match not found');
    await this.assertOrgMember(m.rows[0].organization_id, user);
    return m.rows[0].organization_id;
  }

  async assertTournamentOrgMember(tournamentId: string, user: JwtPayload): Promise<string> {
    const t = await this.pool.query(`SELECT organization_id FROM tournaments WHERE id = $1`, [tournamentId]);
    if (t.rowCount === 0) throw new ForbiddenException('Tournament not found');
    await this.assertOrgMember(t.rows[0].organization_id, user);
    return t.rows[0].organization_id;
  }
}
