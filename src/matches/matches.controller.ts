import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsObject,
  IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser } from '../common/auth';
import { Public } from '../common/public.decorator';
import { MatchesService } from './matches.service';
import { ScoringService } from './scoring.service';
import { StatsService } from './stats.service';

// ---------------- DTOs ----------------
class CreateMatchDto {
  /** Every match lives under a tournament (super-over child matches are the
   *  only exception, and those are created internally, never via this DTO). */
  @IsUUID() tournament_id!: string;
  @IsOptional() @IsInt() match_number?: number;
  @IsOptional() @IsIn(['group', 'league', 'quarter_final', 'semi_final', 'final', 'playoff', 'qualifier', 'eliminator', 'custom'])
  stage?: string;
  @IsOptional() @IsString() stage_label?: string;
  @IsOptional() @IsUUID() group_id?: string;
  @IsUUID() team_a_id!: string;
  @IsUUID() team_b_id!: string;
  @IsOptional() @IsUUID() venue_id?: string;
  @IsDateString() scheduled_start!: string;
  /** Base ruleset (from GET /formats) — omit to inherit the tournament's format, or T20 for a bare friendly */
  @IsOptional() @IsUUID() format_id?: string;
  /** Deep-merged onto the format's rules, e.g. {"overs_per_innings":10,"no_ball":{"free_hit":false},"max_overs_per_bowler":2} */
  @IsOptional() @IsObject() rule_overrides?: object;
}

class SquadPlayerDto {
  @IsUUID() player_id!: string;
  @IsOptional() @IsBoolean() is_playing_xi?: boolean;
  @IsOptional() @IsBoolean() is_twelfth?: boolean;
  /** 12th man batting allowed (IPL-style impact rules) */
  @IsOptional() @IsBoolean() can_bat?: boolean;
  @IsOptional() @IsBoolean() can_bowl?: boolean;
  @IsOptional() @IsBoolean() is_captain?: boolean;
  @IsOptional() @IsBoolean() is_wicket_keeper?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(15) batting_order?: number;
}

class SetSquadDto {
  @IsUUID() team_id!: string;
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => SquadPlayerDto)
  players!: SquadPlayerDto[];
}

class TossDto {
  @IsUUID() winner_team_id!: string;
  @IsIn(['bat', 'bowl']) decision!: 'bat' | 'bowl';
}

class OpenersDto {
  @IsUUID() striker_id!: string;
  @IsUUID() non_striker_id!: string;
  @IsUUID() bowler_id!: string;
}

class WicketDto {
  @IsIn(['bowled', 'caught', 'caught_behind', 'caught_and_bowled', 'lbw', 'run_out', 'stumped', 'hit_wicket',
         'retired_hurt', 'retired_out', 'obstructing_field', 'timed_out', 'hit_ball_twice', 'handled_ball', 'declared_out'])
  type!: string;
  /** Defaults to the striker */
  @IsOptional() @IsUUID() dismissed_player_id?: string;
  @IsOptional() @IsUUID() fielder_id?: string;
  /** For run-outs: which end was the wicket broken at */
  @IsOptional() @IsIn(['striker_end', 'non_striker_end']) wicket_broken_end?: string;
}

class BallDto {
  /** Device-generated UUID — makes retries idempotent */
  @IsUUID() client_event_id!: string;
  /** Current state seq you scored against (409 SEQ_CONFLICT if stale) */
  @IsOptional() @IsInt() expected_seq?: number;
  /** New bowler at the start of an over; otherwise sticky */
  @IsOptional() @IsUUID() bowler_id?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) runs_batter?: number;
  @IsOptional() @IsIn(['wide', 'no_ball', 'bye', 'leg_bye', 'penalty']) extra_type?: string;
  /** Runs beyond the automatic penalty (e.g. wide + 2 runs → 2). For a
   *  no-ball + byes/leg-byes combo, this is the byes/leg-byes run count. */
  @IsOptional() @IsInt() @Min(0) @Max(8) runs_extras?: number;
  /** Only with extra_type='no_ball': flags that runs_extras is byes/leg-byes
   *  run off the no-ball rather than runs off the bat (mutually exclusive
   *  with runs_batter being scorer's off-the-bat count for that ball). */
  @IsOptional() @IsIn(['bye', 'leg_bye']) secondary_extra_type?: string;
  @IsOptional() @IsBoolean() is_boundary_four?: boolean;
  @IsOptional() @IsBoolean() is_boundary_six?: boolean;
  @IsOptional() @ValidateNested() @Type(() => WicketDto) wicket?: WicketDto;
  /** {"angle_deg":210,"distance_pct":95} */
  @IsOptional() @IsObject() wagon?: object;
  @IsOptional() @IsObject() pitch?: object;
  @IsOptional() @IsString() shot_type?: string;
}

class NewBatterDto {
  @IsUUID() player_id!: string;
}

class CloseInningsDto {
  @IsIn(['declared', 'overs', 'all_out', 'forfeited']) reason!: 'declared' | 'overs' | 'all_out' | 'forfeited';
}

class FollowOnDto {
  /** true = opponent bats again immediately (innings marked is_follow_on) */
  @IsBoolean() enforce!: boolean;
}

class InterruptionDto {
  /** 'rain' | 'bad_light' | 'wet_outfield' | free text */
  @IsString() @IsNotEmpty() @MaxLength(80) reason!: string;
}

class ResumeDto {
  @IsOptional() @IsInt() @Min(0) overs_lost?: number;
  /** New innings length (e.g. 20 → 14 after rain) */
  @IsOptional() @IsInt() @Min(1) revised_max_overs?: number;
  /** DLS-revised chase target */
  @IsOptional() @IsInt() @Min(1) revised_target?: number;
  /** 'DLS' | 'VJD' | 'manual' */
  @IsOptional() @IsString() method?: string;
}

class UpdateMatchSettingsDto {
  @IsOptional() @IsInt() @Min(1) overs_per_innings?: number;
  @IsOptional() @IsInt() @Min(1) players_per_side?: number;
  @IsOptional() @IsInt() @Min(1) wickets_to_fall?: number;
  @IsOptional() @IsInt() @Min(1) max_overs_per_bowler?: number | null;
  @IsOptional() @IsBoolean() free_hit?: boolean;
  @IsOptional() @IsBoolean() dls_enabled?: boolean;
}

class BallBatchDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => BallDto)
  balls!: BallDto[];
}

class SubstitutionDto {
  @IsUUID() team_id!: string;
  @IsUUID() out_player_id!: string;
  @IsUUID() in_player_id!: string;
  /** 'impact_player' | 'concussion' | 'injury' | 'substitute' */
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsBoolean() can_bat?: boolean;
  @IsOptional() @IsBoolean() can_bowl?: boolean;
}

class EditMatchDto {
  @IsOptional() @IsDateString() scheduled_start?: string;
  @IsOptional() @IsUUID() format_id?: string;
  @IsOptional() @IsObject() rule_overrides?: object;
}

class MatchOfficialDto {
  @IsUUID() official_id!: string;
  @IsIn(['field_umpire_1', 'field_umpire_2', 'tv_umpire', 'reserve_umpire', 'referee', 'scorer'])
  duty!: string;
}

class SetOfficialsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => MatchOfficialDto)
  officials!: MatchOfficialDto[];
}

class FinalizeDto {
  @IsOptional() @IsUUID() player_of_match_id?: string;
  @IsOptional() @IsIn(['win', 'tie', 'no_result', 'abandoned', 'forfeit', 'draw']) result_type?: string;
  @IsOptional() @IsString() result_summary?: string;
}

class CommentaryDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) body!: string;
  @IsOptional() @IsBoolean() is_highlight?: boolean;
  @IsOptional() @IsUUID() ball_id?: string;
  @IsOptional() @IsUUID() fielder_player_id?: string;
}

class AssignScorerDto {
  @IsUUID() user_id!: string;
  @IsOptional() @IsDateString() expires_at?: string;
}

class EditBallDto {
  @IsOptional() @IsInt() @Min(0) @Max(7) runs_batter?: number;
  @IsOptional() @IsIn(['wide', 'no_ball', 'bye', 'leg_bye']) extra_type?: string;
  @IsOptional() @IsInt() @Min(0) @Max(7) runs_extras?: number;
  @IsOptional() @IsIn(['bye', 'leg_bye']) secondary_extra_type?: string;
  @IsOptional() @IsInt() @Min(0) @Max(7) secondary_extra_runs?: number;
  @IsOptional() @IsBoolean() is_boundary_four?: boolean;
  @IsOptional() @IsBoolean() is_boundary_six?: boolean;
  @IsOptional() @IsIn(['bowled', 'caught', 'caught_behind', 'caught_and_bowled', 'lbw', 'run_out',
    'stumped', 'hit_wicket', 'retired_hurt', 'retired_out', 'obstructing_field', 'timed_out',
    'hit_ball_twice', 'handled_ball', 'declared_out']) wicket_type?: string;
  @IsOptional() @IsUUID() dismissed_player_id?: string;
  @IsOptional() @IsUUID() fielder_id?: string;
  @IsOptional() @IsIn(['striker_end', 'non_striker_end']) wicket_broken_end?: string;
}

// ---------------- Controller ----------------
@ApiTags('Matches & Scoring')
@Controller()
export class MatchesController {
  constructor(
    private readonly matches: MatchesService,
    private readonly scoring: ScoringService,
    private readonly stats: StatsService,
    private readonly access: AccessService,
  ) {}

  // ---- public reads ----
  /** Public match list (filter by tournament / org / status). */
  @Public() @Get('matches')
  list(@Query('tournament') tournament?: string, @Query('org') org?: string, @Query('status') status?: string) {
    return this.matches.list({ tournament, org, status });
  }

  /** Match detail + innings summary. */
  @Public() @Get('matches/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.get(id);
  }

  /** Live state snapshot — Redis-first, Postgres fallback (`source` field says which). Prefer the WebSocket feed (/live) for push updates. */
  @Public() @Get('matches/:id/state')
  state(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.state(id);
  }

  /** Last N ball events (Redis stream) for instant UI hydration. */
  @Public() @Get('matches/:id/balls/recent')
  recentBalls(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: number) {
    return this.matches.recentBalls(id, limit ? Number(limit) : 30);
  }

  /** Live presence: {viewers, scorers} currently connected via WebSocket. */
  @Public() @Get('matches/:id/presence')
  presence(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.presence(id);
  }

  /** Full scorecard (batting/bowling cards, fall of wickets). */
  @Public() @Get('matches/:id/scorecard')
  scorecard(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.scorecard(id);
  }

  /** Over-by-over data (Manhattan / over comparison). */
  @Public() @Get('matches/:id/overs')
  overs(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.overs(id);
  }

  @Public() @Get('matches/:id/commentary')
  commentary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: number,
    @Query('before') before?: string,
    @Query('innings') innings?: string,
  ) {
    return this.matches.commentary(id, limit ? Number(limit) : 50, before, innings ? Number(innings) : undefined);
  }

  @Public() @Get('matches/:id/mvp')
  mvp(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.mvp(id);
  }

  /** Stats tab: wagon-wheel vectors, partnerships, over-by-over run rate. */
  @Public() @Get('matches/:id/stats')
  matchStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.matchStats(id);
  }

  @Public() @Get('matches/:id/squads')
  squads(@Param('id', ParseUUIDPipe) id: string) {
    return this.matches.squads(id);
  }

  @Public() @Get('teams/:teamA/head-to-head/:teamB')
  headToHead(@Param('teamA', ParseUUIDPipe) a: string, @Param('teamB', ParseUUIDPipe) b: string) {
    return this.stats.headToHead(a, b);
  }

  /** Tournament leaderboards: metric = runs | wickets | mvp | sr | economy */
  @Public() @Get('tournaments/:id/stats/leaders')
  leaders(@Param('id', ParseUUIDPipe) id: string, @Query('metric') metric = 'runs') {
    return this.stats.leaderboard(id, metric);
  }

  // ---- admin setup ----
  /** Schedule a match manually (standalone friendly or extra tournament fixture). */
  @Post('orgs/:orgId/matches')
  @UseGuards(JwtAuthGuard)
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateMatchDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.matches.createManual(orgId, dto);
  }

  /** Set one team's squad: playing XI + 12th man with can_bat/can_bowl toggles. */
  @Put('matches/:id/squads')
  @UseGuards(JwtAuthGuard)
  async setSquad(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: SetSquadDto) {
    await this.access.assertMatchOrgMember(id, user);
    return this.matches.setSquad(id, dto.team_id, dto.players);
  }

  /** Grant a user match-scoped scorer access. */
  @Post('matches/:id/scorers')
  @UseGuards(JwtAuthGuard)
  async assignScorer(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: AssignScorerDto) {
    await this.access.assertMatchOrgMember(id, user);
    return this.matches.assignScorer(id, dto, user.sub);
  }

  /** Set match officials (umpires, TV umpire, referee, scorer). */
  @Put('matches/:id/officials')
  @UseGuards(JwtAuthGuard)
  async setOfficials(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: SetOfficialsDto) {
    await this.access.assertMatchOrgMember(id, user);
    return this.matches.setOfficials(id, dto.officials);
  }

  /** Substitution: 12th man / concussion / impact player, with bat-bowl eligibility. */
  @Post('matches/:id/substitutions')
  @UseGuards(JwtAuthGuard)
  async substitute(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: SubstitutionDto) {
    await this.access.assertCanScore(id, user);
    return this.matches.substitute(id, dto);
  }

  /** Edit match details (scheduled_start, format, rules) before toss. */
  @Patch('matches/:id')
  @UseGuards(JwtAuthGuard)
  async editMatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: EditMatchDto) {
    await this.access.assertMatchOrgMember(id, user);
    return this.matches.editMatch(id, dto);
  }

  /** Delete a match (only in scheduled state). */
  @Delete('matches/:id')
  @UseGuards(JwtAuthGuard)
  async deleteMatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertMatchOrgMember(id, user);
    return this.matches.deleteMatch(id);
  }

  // ---- scoring flow ----
  /** Record the toss. Freezes the rules snapshot and creates innings 1. */
  @Post('matches/:id/toss')
  @UseGuards(JwtAuthGuard)
  async toss(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: TossDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.toss(id, dto);
  }

  /** Undo the toss: go back from 'toss' status to 'scheduled', allowing re-selection of squads or re-doing the toss. */
  @Delete('matches/:id/toss')
  @UseGuards(JwtAuthGuard)
  async undoToss(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertCanScore(id, user);
    return this.scoring.undoToss(id);
  }

  /** Edit match settings (overs, players per side, max overs per bowler, free hit, DLS) before or between innings. */
  @Patch('matches/:id/settings')
  @UseGuards(JwtAuthGuard)
  async updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateMatchSettingsDto,
  ) {
    await this.access.assertCanScore(id, user);
    return this.scoring.updateSettings(id, dto);
  }

  /** Set opening batters + bowler; match goes live. Also used after an innings break. */
  @Post('matches/:id/openers')
  @UseGuards(JwtAuthGuard)
  async openers(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: OpenersDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.openers(id, dto);
  }

  /** Score one ball. Returns the new state + any effects (over_complete, innings_complete, match_complete…). */
  @Post('matches/:id/balls')
  @UseGuards(JwtAuthGuard)
  async ball(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: BallDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.ball(id, user.sub, dto);
  }

  /** Send in the next batter after a wicket. */
  @Post('matches/:id/new-batter')
  @UseGuards(JwtAuthGuard)
  async newBatter(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: NewBatterDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.newBatter(id, dto);
  }

  /** Undo the most recent ball (append-only supersede + full replay rebuild). */
  @Delete('matches/:id/balls/last')
  @UseGuards(JwtAuthGuard)
  async undo(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertCanScore(id, user);
    return this.scoring.undoLast(id);
  }

  /** Offline sync: apply queued balls in order; stops at first conflict for client rebase. */
  @Post('matches/:id/balls/batch')
  @UseGuards(JwtAuthGuard)
  async ballBatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: BallBatchDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.ballBatch(id, user.sub, dto.balls);
  }

  /** Pause play for rain / bad light. Match status → rain_delay. */
  @Post('matches/:id/interruptions')
  @UseGuards(JwtAuthGuard)
  async interruption(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: InterruptionDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.startInterruption(id, dto);
  }

  /** Resume play, optionally with a DLS/manual revision (reduced overs and/or revised target). */
  @Post('matches/:id/interruptions/resume')
  @UseGuards(JwtAuthGuard)
  async resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: ResumeDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.resumeInterruption(id, dto);
  }

  /** Undo an innings close/declare — reopens the previous innings while the next one hasn't started. */
  @Post('matches/:id/innings/reopen')
  @UseGuards(JwtAuthGuard)
  async reopenInnings(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertCanScore(id, user);
    return this.scoring.reopenInnings(id);
  }

  /** Decide the pending follow-on (Tests): enforce or bat normally. */
  @Post('matches/:id/follow-on')
  @UseGuards(JwtAuthGuard)
  async followOn(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: FollowOnDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.followOn(id, dto);
  }

  /** Create the Super Over tie-breaker child match for a tied match. */
  @Post('matches/:id/super-over')
  @UseGuards(JwtAuthGuard)
  async superOver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertCanScore(id, user);
    return this.scoring.createSuperOver(id);
  }

  /** Close the current innings manually (declaration, forfeit, rain-shortened). */
  @Post('matches/:id/innings/close')
  @UseGuards(JwtAuthGuard)
  async closeInnings(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: CloseInningsDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.closeInningsManual(id, dto.reason);
  }

  /** Finalize: set player of the match, force a result (abandoned/no_result), rebuild stats. */
  @Post('matches/:id/finalize')
  @UseGuards(JwtAuthGuard)
  async finalize(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: FinalizeDto) {
    await this.access.assertCanScore(id, user);
    return this.scoring.finalize(id, dto);
  }

  /** Add manual commentary (commentator/scorer). */
  @Post('matches/:id/commentary')
  @UseGuards(JwtAuthGuard)
  async addCommentary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: CommentaryDto) {
    await this.access.assertCanScore(id, user);
    return this.matches.addCommentary(id, user.sub, dto);
  }

  /** Returns whether the authenticated user has scoring access for this match. */
  @Get('matches/:id/can-score')
  @UseGuards(JwtAuthGuard)
  async canScore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    try {
      await this.access.assertCanScore(id, user);
      return { can_score: true };
    } catch {
      return { can_score: false };
    }
  }

  /** Correct any ball: supersede + insert at same seq + replay innings. */
  @Patch('matches/:id/balls/:ballId')
  @UseGuards(JwtAuthGuard)
  async editBall(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ballId', ParseUUIDPipe) ballId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: EditBallDto,
  ) {
    await this.access.assertCanScore(id, user);
    return this.scoring.editBall(id, ballId, dto, user.sub);
  }
}
