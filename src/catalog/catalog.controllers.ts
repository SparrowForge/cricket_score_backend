import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min,
} from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser } from '../common/auth';
import { SaasService } from '../saas/saas.service';
import { CatalogService } from './catalog.service';

// ---------------- DTOs ----------------
class CreateFormatDto {
  @IsString() @IsNotEmpty() name!: string;
  @Matches(/^[a-z0-9-]{2,40}$/) slug!: string;
  /** Full rule document — see built-in formats (GET /formats) for the shape */
  @IsObject() rules!: object;
}

class CreateVenueDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsInt() @Min(0) capacity?: number;
  @IsOptional() @IsString() image_url?: string;
}

class UpdateVenueDto extends CreateVenueDto {
  @IsOptional() @IsString() declare name: string;
}

class CreateTeamDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @MaxLength(6) short_name!: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,60}$/) slug!: string;
  @IsOptional() @IsString() logo_url?: string;
  /** Hex color, e.g. #f9cd05 */
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) primary_color?: string;
  @IsOptional() @IsUUID() home_venue_id?: string;
}

class UpdateTeamDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(6) short_name?: string;
  @IsOptional() @IsString() logo_url?: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) primary_color?: string;
  @IsOptional() @IsUUID() home_venue_id?: string;
}

class AddTeamPlayerDto {
  @IsUUID() player_id!: string;
  @IsOptional() @IsInt() @Min(0) jersey_number?: number;
  @IsOptional() @IsBoolean() is_captain?: boolean;
  @IsOptional() @IsBoolean() is_wicket_keeper?: boolean;
}

class CreatePlayerDto {
  @IsString() @IsNotEmpty() @MaxLength(120) full_name!: string;
  @IsOptional() @IsString() display_name?: string;
  @IsOptional() @IsDateString() date_of_birth?: string;
  @IsOptional() @IsIn(['right_hand', 'left_hand']) batting_style?: string;
  @IsOptional() @IsString() bowling_style?: string;
  @IsOptional() @IsIn(['batter', 'bowler', 'all_rounder', 'wicket_keeper', 'wicket_keeper_batter'])
  primary_role?: string;
  @IsOptional() @IsString() photo_url?: string;
  @IsOptional() @IsString() country?: string;
}

class UpdatePlayerDto extends CreatePlayerDto {
  @IsOptional() @IsString() declare full_name: string;
}

// ---------------- Controllers ----------------
@ApiTags('Formats')
@Controller()
@UseGuards(JwtAuthGuard)
export class FormatsController {
  constructor(private readonly catalog: CatalogService, private readonly access: AccessService) {}

  /** Built-in formats (T20/ODI/T10/Sixes/Test) plus your org's custom formats. */
  @Get('formats')
  formats(@Query('org') orgId?: string) {
    return this.catalog.formats(orgId);
  }

  /** Create a custom format from a JSON rule document. */
  @Post('orgs/:orgId/formats')
  async createFormat(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateFormatDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.createFormat(orgId, dto);
  }
}

class CreateOfficialDto {
  @IsString() @IsNotEmpty() @MaxLength(120) full_name!: string;
  @IsIn(['umpire', 'tv_umpire', 'referee', 'scorer']) official_type!: string;
  @IsOptional() @IsString() photo_url?: string;
}

class UpdateOfficialDto {
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @IsIn(['umpire', 'tv_umpire', 'referee', 'scorer']) official_type?: string;
  @IsOptional() @IsString() photo_url?: string;
}

@ApiTags('Officials')
@Controller('orgs/:orgId/officials')
@UseGuards(JwtAuthGuard)
export class OfficialsController {
  constructor(private readonly catalog: CatalogService, private readonly access: AccessService) {}

  @Get()
  async list(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.officials(orgId);
  }

  @Post()
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOfficialDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.createOfficial(orgId, dto);
  }

  @Patch(':officialId')
  async update(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('officialId', ParseUUIDPipe) officialId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOfficialDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.updateOfficial(officialId, dto);
  }

  @Delete(':officialId')
  async remove(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('officialId', ParseUUIDPipe) officialId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.deleteOfficial(officialId);
  }
}

@ApiTags('Venues')
@Controller('orgs/:orgId/venues')
@UseGuards(JwtAuthGuard)
export class VenuesController {
  constructor(private readonly catalog: CatalogService, private readonly access: AccessService) {}

  @Get()
  async list(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.venues(orgId);
  }

  @Post()
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVenueDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.createVenue(orgId, dto);
  }

  @Patch(':venueId')
  async update(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateVenueDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.updateVenue(venueId, dto);
  }
}

@ApiTags('Teams')
@Controller()
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly access: AccessService,
    private readonly saas: SaasService,
  ) {}

  @Get('orgs/:orgId/teams')
  async list(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.teams(orgId);
  }

  @Post('orgs/:orgId/teams')
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTeamDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    await this.saas.assertQuota(orgId, 'max_teams');
    return this.catalog.createTeam(orgId, dto);
  }

  /** Team detail with current squad. */
  @Get('teams/:teamId')
  team(@Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.catalog.team(teamId);
  }

  /** Team record: W/L/T, highest/lowest/avg totals, recent form. */
  @Get('teams/:teamId/stats')
  teamStats(@Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.catalog.teamStats(teamId);
  }

  @Patch('teams/:teamId')
  async update(
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTeamDto,
  ) {
    await this.access.assertOrgMember(await this.catalog.orgIdOfTeam(teamId), user);
    return this.catalog.updateTeam(teamId, dto);
  }

  @Delete('teams/:teamId')
  async remove(@Param('teamId', ParseUUIDPipe) teamId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(await this.catalog.orgIdOfTeam(teamId), user);
    return this.catalog.deleteTeam(teamId);
  }

  /** Add a player to the team squad (jersey / captain / keeper flags). */
  @Post('teams/:teamId/players')
  async addPlayer(
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddTeamPlayerDto,
  ) {
    await this.access.assertOrgMember(await this.catalog.orgIdOfTeam(teamId), user);
    return this.catalog.addTeamPlayer(teamId, dto);
  }

  @Delete('teams/:teamId/players/:playerId')
  async removePlayer(
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('playerId', ParseUUIDPipe) playerId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgMember(await this.catalog.orgIdOfTeam(teamId), user);
    return this.catalog.removeTeamPlayer(teamId, playerId);
  }
}

@ApiTags('Players')
@Controller()
@UseGuards(JwtAuthGuard)
export class PlayersController {
  constructor(private readonly catalog: CatalogService, private readonly access: AccessService) {}

  @Get('orgs/:orgId/players')
  async list(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Query('search') search?: string,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.players(orgId, search);
  }

  @Post('orgs/:orgId/players')
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePlayerDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.createPlayer(orgId, dto);
  }

  /** Player profile with career stats + recent matches. */
  @Get('players/:playerId')
  player(@Param('playerId', ParseUUIDPipe) playerId: string) {
    return this.catalog.player(playerId);
  }

  @Patch('players/:playerId')
  async update(
    @Param('playerId', ParseUUIDPipe) playerId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePlayerDto,
  ) {
    await this.access.assertOrgMember(await this.catalog.orgIdOfPlayer(playerId), user);
    return this.catalog.updatePlayer(playerId, dto);
  }

  @Delete('players/:playerId')
  async remove(@Param('playerId', ParseUUIDPipe) playerId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(await this.catalog.orgIdOfPlayer(playerId), user);
    return this.catalog.deletePlayer(playerId);
  }
}
