import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsObject,
  IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser } from '../common/auth';
import { Public } from '../common/public.decorator';
import { SaasService } from '../saas/saas.service';
import { TournamentsService } from './tournaments.service';

class CreateTournamentDto {
  @IsString() @IsNotEmpty() @MaxLength(150) name!: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,60}$/) slug!: string;
  @IsOptional() @IsString() season?: string;
  @IsUUID() format_id!: string;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsString() banner_url?: string;
  @IsOptional() @IsString() description?: string;
  /** Deep-merged over the format rules, e.g. {"overs_per_innings":15} */
  @IsOptional() @IsObject() rule_overrides?: object;
  /** e.g. {"win":2,"tie":1,"no_result":1,"tiebreakers":["points","nrr"]} */
  @IsOptional() @IsObject() points_rules?: object;
  @IsOptional() @IsBoolean() is_public?: boolean;
}

class UpdateTournamentDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  /** Changing this re-files every participant's career stats into the new format family. */
  @IsOptional() @IsUUID() format_id?: string;
  @IsOptional() @IsString() season?: string;
  @IsOptional() @IsIn(['draft', 'published', 'in_progress', 'completed', 'archived', 'cancelled']) status?: string;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsString() banner_url?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsObject() rule_overrides?: object;
  @IsOptional() @IsObject() points_rules?: object;
  @IsOptional() @IsBoolean() is_public?: boolean;
}

class CreateGroupDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsInt() sort_order?: number;
}

class AttachTeamDto {
  @IsUUID() team_id!: string;
  @IsOptional() @IsUUID() group_id?: string;
  @IsOptional() @IsInt() seed?: number;
}

class GenerateFixturesDto {
  @IsIn(['round_robin', 'knockout', 'hybrid']) type!: 'round_robin' | 'knockout' | 'hybrid';
  @IsOptional() @IsInt() @Min(1) @Max(2) legs?: 1 | 2;
  /** hybrid only: how many teams advance to knockout */
  @IsOptional() @IsInt() @Min(2) knockoutFrom?: number;
  @IsDateString() startDate!: string;
  /** ISO weekdays 1(Mon)–7(Sun), e.g. [6,7] for weekends */
  @IsArray() @ArrayMinSize(1) matchDays!: number[];
  @IsInt() @Min(1) matchesPerDay!: number;
  @IsArray() @ArrayMinSize(1) venueIds!: string[];
  /** Maximum number of matches to generate (optional limit) */
  @IsOptional() @IsInt() @Min(1) maxMatches?: number;
}

class DraftFixtureDto {
  @IsOptional() @IsString() stage?: string;
  @IsOptional() @IsString() stageLabel?: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsUUID() teamAId?: string | null;
  @IsOptional() @IsUUID() teamBId?: string | null;
  @IsDateString() scheduledStart!: string;
  @IsUUID() venueId!: string;
}

class ConfirmFixturesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DraftFixtureDto)
  fixtures!: DraftFixtureDto[];
}

/** Tournament-wide match settings — stored as `rule_overrides`, frozen onto every fixture. */
class MatchSettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(500) overs_per_innings?: number;
  @IsOptional() @IsInt() @Min(2) @Max(15) players_per_side?: number;
  /** Derived from the last-single-batter switch, not typed in directly. */
  @IsOptional() @IsInt() @Min(1) @Max(15) wickets_to_fall?: number;
  @IsOptional() @IsInt() @Min(1) @Max(500) max_overs_per_bowler?: number;
  /** Alternative to `wickets_to_fall`: on = the last batter carries on alone. */
  @IsOptional() @IsBoolean() allow_last_single_batter?: boolean;
  @IsOptional() @IsObject() no_ball?: { free_hit?: boolean };
  @IsOptional() @IsObject() dls?: { enabled?: boolean };
}

class GenerateMatchesDto {
  @IsOptional() @IsObject() @ValidateNested() @Type(() => MatchSettingsDto) match_settings?: MatchSettingsDto;
  /** Times each pair meets: 3 teams × 3 = A-B, A-C, B-C three times each = 9. */
  @IsInt() @Min(1) @Max(20) matches_per_pair!: number;
  /** Required to replace fixtures that already exist (409 without it). */
  @IsOptional() @IsBoolean() overwrite?: boolean;
  /** Return the fixture list without saving settings or creating matches. */
  @IsOptional() @IsBoolean() preview?: boolean;
  @IsOptional() @IsDateString() start_date?: string;
  /** ISO weekdays 1(Mon)–7(Sun). Anything outside that never matches a date. */
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) match_days?: number[];
  @IsOptional() @IsInt() @Min(1) matches_per_day?: number;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) venue_ids?: string[];
}

@ApiTags('Tournaments')
@Controller()
export class TournamentsController {
  constructor(
    private readonly tournaments: TournamentsService,
    private readonly access: AccessService,
    private readonly saas: SaasService,
  ) {}

  /** Public tournament list (filter by status / org). */
  @Public()
  @Get('tournaments')
  list(@Query('org') org?: string, @Query('status') status?: string) {
    return this.tournaments.list({ org, status });
  }

  /** Public tournament detail with groups + teams. */
  @Public()
  @Get('tournaments/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournaments.get(id);
  }

  /** Public points table. */
  @Public()
  @Get('tournaments/:id/points-table')
  pointsTable(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournaments.pointsTable(id);
  }

  @Post('orgs/:orgId/tournaments')
  @UseGuards(JwtAuthGuard)
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTournamentDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    await this.saas.assertQuota(orgId, 'max_tournaments');
    return this.tournaments.create(orgId, user.sub, dto);
  }

  @Patch('tournaments/:id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTournamentDto,
  ) {
    await this.access.assertTournamentPermission(id, user, 'tournament:update');
    return this.tournaments.update(id, dto);
  }

  /** Rebuild career aggregates for everyone who played in this tournament. */
  @Post('tournaments/:id/recalculate-stats')
  @UseGuards(JwtAuthGuard)
  async recalculateStats(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertTournamentPermission(id, user, 'tournament:update');
    return this.tournaments.recalculateStats(id);
  }

  @Delete('tournaments/:id')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertTournamentPermission(id, user, 'tournament:delete');
    return this.tournaments.remove(id);
  }

  @Post('tournaments/:id/groups')
  @UseGuards(JwtAuthGuard)
  async createGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateGroupDto,
  ) {
    await this.access.assertTournamentOrgMember(id, user);
    return this.tournaments.createGroup(id, dto.name, dto.sort_order);
  }

  @Post('tournaments/:id/teams')
  @UseGuards(JwtAuthGuard)
  async attachTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AttachTeamDto,
  ) {
    await this.access.assertTournamentOrgMember(id, user);
    return this.tournaments.attachTeam(id, dto);
  }

  @Delete('tournaments/:id/teams/:teamId')
  @UseGuards(JwtAuthGuard)
  async detachTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.access.assertTournamentOrgMember(id, user);
    return this.tournaments.detachTeam(id, teamId);
  }

  /** Generate DRAFT fixtures for review — nothing is persisted. */
  @Post('tournaments/:id/fixtures/generate')
  @UseGuards(JwtAuthGuard)
  async generate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: GenerateFixturesDto,
  ) {
    await this.access.assertTournamentOrgMember(id, user);
    return this.tournaments.generate(id, { ...dto, legs: dto.legs ?? 1 } as any);
  }

  /**
   * One-shot setup used by the tournament screen: save the match settings and
   * create the round-robin fixtures that play by them, in one transaction.
   *
   * 400 carries `{ fields }` for inline errors; 409 `MATCHES_EXIST` means the
   * caller must confirm and retry with `overwrite: true`.
   */
  @Post('tournaments/:id/generate-matches')
  @UseGuards(JwtAuthGuard)
  async generateMatches(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: GenerateMatchesDto,
  ) {
    await this.access.assertTournamentPermission(id, user, 'tournament:update');
    return this.tournaments.generateMatches(id, dto);
  }

  /** Persist reviewed draft fixtures as scheduled matches. */
  @Post('tournaments/:id/fixtures/confirm')
  @UseGuards(JwtAuthGuard)
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmFixturesDto,
  ) {
    await this.access.assertTournamentOrgMember(id, user);
    return this.tournaments.confirmFixtures(id, dto.fixtures as any);
  }
}
