import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, Min,
} from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser, Roles, RolesGuard } from '../common/auth';
import { Public } from '../common/public.decorator';
import { SaasService } from './saas.service';

class CreatePlanDto {
  @Matches(/^[a-z0-9-]{2,40}$/) slug!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsInt() @Min(0) price_cents!: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsIn(['month', 'year', 'one_time']) billing_interval?: string;
  @IsOptional() @IsInt() @Min(0) trial_days?: number;
  /** Entitlements JSON, e.g. {"max_tournaments":5,"dls":true} — null value = unlimited */
  @IsOptional() @IsObject() features?: object;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() is_public?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}

class UpdatePlanDto extends CreatePlanDto {
  @IsOptional() @Matches(/^[a-z0-9-]{2,40}$/) declare slug: string;
  @IsOptional() @IsString() declare name: string;
  @IsOptional() @IsInt() @Min(0) declare price_cents: number;
}

class ChangePlanDto {
  @IsUUID() plan_id!: string;
}

@ApiTags('Plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly saas: SaasService) {}

  /** Public pricing (marketing site). No auth required. */
  @Public()
  @Get()
  publicPlans() {
    return this.saas.publicPlans();
  }

  /** All plans incl. hidden/inactive (super admin). */
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  allPlans() {
    return this.saas.allPlans();
  }

  @Post('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  create(@Body() dto: CreatePlanDto) {
    return this.saas.createPlan(dto);
  }

  @Patch('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.saas.updatePlan(id, dto);
  }

  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  retire(@Param('id', ParseUUIDPipe) id: string) {
    return this.saas.retirePlan(id);
  }
}

@ApiTags('Subscriptions')
@Controller('orgs/:orgId/subscription')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(
    private readonly saas: SaasService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async get(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.saas.orgSubscription(orgId);
  }

  @Get('entitlements')
  async entitlements(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.saas.entitlements(orgId);
  }

  /** Switch the org to another plan (trial starts automatically on paid plans). */
  @Post()
  async change(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePlanDto,
  ) {
    await this.access.assertOrgOwner(orgId, user);
    return this.saas.changePlan(orgId, dto.plan_id);
  }

  @Post('cancel')
  async cancel(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgOwner(orgId, user);
    return this.saas.cancel(orgId);
  }
}
