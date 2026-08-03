import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional,
  IsString, IsUUID, Matches, MaxLength, Min,
} from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser } from '../common/auth';
import { Public } from '../common/public.decorator';
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
  @IsOptional()
  @IsIn([
    'right_arm_fast', 'right_arm_fast_medium', 'right_arm_medium', 'right_arm_off_break', 'right_arm_leg_break',
    'left_arm_fast', 'left_arm_fast_medium', 'left_arm_medium', 'left_arm_orthodox', 'left_arm_chinaman', 'none',
  ])
  bowling_style?: string;
  @IsOptional() @IsIn(['batter', 'bowler', 'all_rounder', 'wicket_keeper', 'wicket_keeper_batter'])
  primary_role?: string;
  @IsOptional() @IsString() photo_url?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsInt() @Min(80) height_cm?: number;
  /** e.g. ["Bangladesh U19", "Dhaka Metro"] */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) major_teams?: string[];
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
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
    await this.access.assertOrgPermission(orgId, user, 'venue:create');
    return this.catalog.createVenue(orgId, dto);
  }

  @Patch(':venueId')
  async update(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateVenueDto,
  ) {
    await this.access.assertOrgPermission(orgId, user, 'venue:update');
    return this.catalog.updateVenue(venueId, dto);
  }

  @Delete(':venueId')
  async remove(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgPermission(orgId, user, 'venue:delete');
    return this.catalog.deleteVenue(venueId);
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
    await this.access.assertOrgPermission(await this.catalog.orgIdOfTeam(teamId), user, 'team:update');
    return this.catalog.updateTeam(teamId, dto);
  }

  @Delete('teams/:teamId')
  async remove(@Param('teamId', ParseUUIDPipe) teamId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgPermission(await this.catalog.orgIdOfTeam(teamId), user, 'team:delete');
    return this.catalog.deleteTeam(teamId);
  }

  /** Add/update a squad member (jersey / captain / keeper flags — upsert). */
  @Post('teams/:teamId/players')
  async addPlayer(
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddTeamPlayerDto,
  ) {
    await this.access.assertOrgPermission(await this.catalog.orgIdOfTeam(teamId), user, 'team:update');
    return this.catalog.addTeamPlayer(teamId, dto);
  }

  @Delete('teams/:teamId/players/:playerId')
  async removePlayer(
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('playerId', ParseUUIDPipe) playerId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertOrgPermission(await this.catalog.orgIdOfTeam(teamId), user, 'team:update');
    return this.catalog.removeTeamPlayer(teamId, playerId);
  }
}

// NOTE: no class-level @UseGuards here — player profiles are public (anyone
// can search and view a profile). Only the org-scoped list and the
// create/update/delete mutations require auth, applied per-route below.
@ApiTags('Players')
@Controller()
export class PlayersController {
  constructor(private readonly catalog: CatalogService, private readonly access: AccessService) {}

  /** Global player search — public, no org scoping. Powers the site-wide "search a player" page. */
  @Public()
  @Get('players')
  search(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.catalog.publicSearch(search, limit ? Number(limit) : undefined);
  }

  @Get('orgs/:orgId/players')
  @UseGuards(JwtAuthGuard)
  async list(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Query('search') search?: string,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.catalog.players(orgId, search);
  }

  @Post('orgs/:orgId/players')
  @UseGuards(JwtAuthGuard)
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePlayerDto,
  ) {
    await this.access.assertOrgPermission(orgId, user, 'player:create');
    return this.catalog.createPlayer(orgId, dto);
  }

  /** Overall top performers: Most Runs / Most Wickets / MVP across all matches.
   *  Declared BEFORE players/:playerId so "leaders" isn't parsed as a UUID. */
  @Public()
  @Get('players/leaders')
  leaders(@Query('limit') limit?: string) {
    return this.catalog.playerLeaders(limit ? Number(limit) : undefined);
  }

  /** Public player profile: bio, career stats, recent matches, current team affiliations. */
  @Public()
  @Get('players/:playerId')
  player(@Param('playerId', ParseUUIDPipe) playerId: string) {
    return this.catalog.player(playerId);
  }

  /** Every match the player appears in, newest first — the profile's "All matches" view.
   *  Declared BEFORE the :playerId PATCH/DELETE block for readability only; the
   *  path is distinct, so ordering does not matter here. */
  @Public()
  @Get('players/:playerId/matches')
  playerMatches(@Param('playerId', ParseUUIDPipe) playerId: string) {
    return this.catalog.playerMatches(playerId);
  }

  @Patch('players/:playerId')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('playerId', ParseUUIDPipe) playerId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePlayerDto,
  ) {
    await this.access.assertOrgPermission(await this.catalog.orgIdOfPlayer(playerId), user, 'player:update');
    return this.catalog.updatePlayer(playerId, dto);
  }

  @Delete('players/:playerId')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('playerId', ParseUUIDPipe) playerId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgPermission(await this.catalog.orgIdOfPlayer(playerId), user, 'player:delete');
    return this.catalog.deletePlayer(playerId);
  }
}
