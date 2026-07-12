import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser } from '../common/auth';
import { OrgsService } from './orgs.service';

class CreateOrgDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  /** URL-safe unique identifier, e.g. "dhaka-cricket-club" */
  @Matches(/^[a-z0-9][a-z0-9-]{1,60}$/)
  slug!: string;

  @IsOptional() @IsString()
  logo_url?: string;
}

class UpdateOrgDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString()
  logo_url?: string;

  @IsOptional() @IsObject()
  settings?: object;
}

class AddMemberDto {
  @IsEmail()
  email!: string;

  /** Role granted org-wide */
  @IsIn(['tournament_admin', 'scorer', 'commentator', 'viewer'])
  role!: string;
}

@ApiTags('Organizations')
@Controller('orgs')
@UseGuards(JwtAuthGuard)
export class OrgsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly access: AccessService,
  ) {}

  /** Create an organization (you become owner, tournament admin, on the free plan). */
  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrgDto) {
    return this.orgs.create(user, dto);
  }

  /** Organizations you own or belong to. */
  @Get()
  mine(@CurrentUser() user: JwtPayload) {
    return this.orgs.mine(user);
  }

  @Get(':orgId')
  async get(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    const org = await this.orgs.get(orgId);
    return { ...org, is_owner: org.owner_user_id === user.sub || user.roles.includes('super_admin') };
  }

  @Patch(':orgId')
  async update(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOrgDto,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    return this.orgs.update(orgId, dto);
  }

  /** Delete an organization (owner only). Soft-delete; blocked while a match is live. */
  @Delete(':orgId')
  async remove(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgOwner(orgId, user);
    return this.orgs.softDelete(orgId);
  }

  @Get(':orgId/members')
  async members(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.orgs.members(orgId);
  }

  /** Add a registered user to the org with a role (tournament_admin | scorer | commentator | viewer). */
  @Post(':orgId/members')
  async addMember(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddMemberDto,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    return this.orgs.addMember(orgId, dto, user.sub);
  }

  @Delete(':orgId/members/:userId')
  async removeMember(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    return this.orgs.removeMember(orgId, userId);
  }
}
