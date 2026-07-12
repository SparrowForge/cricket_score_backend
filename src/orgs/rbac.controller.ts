import {
  BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty, IsArray, IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength,
} from 'class-validator';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser } from '../common/auth';

class CreateRoleDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name!: string;
  @Matches(/^[a-z0-9_]{2,40}$/) slug!: string;
  @IsOptional() @IsString() description?: string;
  /** Permission ids from GET /rbac/permissions */
  @IsArray() @ArrayNotEmpty() @IsInt({ each: true }) permission_ids!: number[];
}

class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) permission_ids?: number[];
}

class AssignRoleDto {
  @IsUUID() user_id!: string;
  @IsUUID() role_id!: string;
  /** Narrow the grant to one tournament */
  @IsOptional() @IsUUID() tournament_id?: string;
  /** Narrow the grant to one match (typical for temp scorers) */
  @IsOptional() @IsUUID() match_id?: string;
  @IsOptional() @IsDateString() expires_at?: string;
}

@ApiTags('RBAC')
@Controller()
@UseGuards(JwtAuthGuard)
export class RbacController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly access: AccessService,
  ) {}

  /** Full permission catalog (resource + action) for the role editor grid. */
  @Get('rbac/permissions')
  async permissions() {
    return (await this.pool.query(`SELECT id, resource, action, description FROM permissions ORDER BY resource, action`)).rows;
  }

  /** System roles + this org's custom roles, with their permission sets. */
  @Get('orgs/:orgId/roles')
  async roles(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return (
      await this.pool.query(
        `SELECT r.id, r.name, r.slug, r.description, r.is_system, r.organization_id,
                coalesce(array_agg(p.resource || ':' || p.action ORDER BY p.resource, p.action)
                         FILTER (WHERE p.id IS NOT NULL), '{}') AS permissions,
                coalesce(array_agg(DISTINCT rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '{}') AS permission_ids
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
         WHERE r.organization_id IS NULL OR r.organization_id = $1
         GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
        [orgId],
      )
    ).rows;
  }

  /** Create a custom org role with a permission set. */
  @Post('orgs/:orgId/roles')
  async createRole(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateRoleDto,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const role = (
        await client.query(
          `INSERT INTO roles (organization_id, name, slug, description, is_system)
           VALUES ($1,$2,$3,$4,false)
           ON CONFLICT (organization_id, slug) DO NOTHING RETURNING *`,
          [orgId, dto.name, dto.slug, dto.description ?? null],
        )
      ).rows[0];
      if (!role) throw new BadRequestException('Role slug already exists in this organization');
      for (const pid of dto.permission_ids) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [role.id, pid],
        );
      }
      await client.query('COMMIT');
      return role;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Edit a custom role; permission_ids (when given) replaces the whole set. */
  @Patch('orgs/:orgId/roles/:roleId')
  async updateRole(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateRoleDto,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    const role = (
      await this.pool.query(
        `UPDATE roles SET name = coalesce($3,name), description = coalesce($4,description)
         WHERE id = $2 AND organization_id = $1 AND NOT is_system RETURNING *`,
        [orgId, roleId, dto.name ?? null, dto.description ?? null],
      )
    ).rows[0];
    if (!role) throw new NotFoundException('Custom role not found (system roles cannot be edited)');
    if (dto.permission_ids) {
      await this.pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      for (const pid of dto.permission_ids) {
        await this.pool.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [roleId, pid],
        );
      }
    }
    return role;
  }

  @Delete('orgs/:orgId/roles/:roleId')
  async deleteRole(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    const res = await this.pool.query(
      `DELETE FROM roles WHERE id = $2 AND organization_id = $1 AND NOT is_system RETURNING id`,
      [orgId, roleId],
    );
    if (res.rowCount === 0) throw new NotFoundException('Custom role not found (system roles cannot be deleted)');
    return { deleted: true };
  }

  /** All role assignments in this org's scope (org / tournament / match grants). */
  @Get('orgs/:orgId/role-assignments')
  async assignments(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return (
      await this.pool.query(
        `SELECT ura.id, ura.user_id, u.full_name, u.email, r.slug AS role,
                ura.tournament_id, t.name AS tournament, ura.match_id, ura.expires_at, ura.created_at
         FROM user_role_assignments ura
         JOIN users u ON u.id = ura.user_id
         JOIN roles r ON r.id = ura.role_id
         LEFT JOIN tournaments t ON t.id = ura.tournament_id
         LEFT JOIN matches m ON m.id = ura.match_id
         WHERE ura.organization_id = $1 OR t.organization_id = $1 OR m.organization_id = $1
         ORDER BY ura.created_at DESC`,
        [orgId],
      )
    ).rows;
  }

  /** Grant a role scoped to the org, a tournament, or a single match. */
  @Post('orgs/:orgId/role-assignments')
  async assign(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AssignRoleDto,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    const res = await this.pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, organization_id, tournament_id, match_id, granted_by, expires_at)
       VALUES ($1,$2, CASE WHEN $4::uuid IS NULL AND $5::uuid IS NULL THEN $3::uuid ELSE NULL END, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING RETURNING *`,
      [dto.user_id, dto.role_id, orgId, dto.tournament_id ?? null, dto.match_id ?? null, user.sub, dto.expires_at ?? null],
    );
    return res.rows[0] ?? { duplicate: true };
  }

  @Delete('orgs/:orgId/role-assignments/:assignmentId')
  async revoke(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    await this.pool.query(`DELETE FROM user_role_assignments WHERE id = $1`, [assignmentId]);
    return { revoked: true };
  }
}
