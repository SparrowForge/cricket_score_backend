import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/auth';
import { EngagementService } from './engagement.service';

class FollowDto {
  @IsIn(['team', 'tournament', 'match', 'player']) entity_type!: string;
  @IsUUID() entity_id!: string;
}

class DeviceDto {
  @IsIn(['ios', 'android', 'web']) platform!: string;
  @IsString() push_token!: string;
  @IsOptional() @IsString() app_version?: string;
}

class PreferencesDto {
  /** e.g. {"wickets":{"push":true},"result":{"push":true,"email":true}} */
  @IsObject() preferences!: object;
  @IsOptional() @IsObject() quiet_hours?: object;
}

@ApiTags('Me — follows & notifications')
@Controller('me')
@UseGuards(JwtAuthGuard)
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get('follows')
  follows(@CurrentUser() user: JwtPayload) {
    return this.engagement.follows(user.sub);
  }

  @Post('follows')
  follow(@CurrentUser() user: JwtPayload, @Body() dto: FollowDto) {
    return this.engagement.follow(user.sub, dto.entity_type, dto.entity_id);
  }

  @Delete('follows/:entityType/:entityId')
  unfollow(
    @CurrentUser() user: JwtPayload,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.engagement.unfollow(user.sub, entityType, entityId);
  }

  /** Register an FCM/APNs push token for this device. */
  @Post('devices')
  registerDevice(@CurrentUser() user: JwtPayload, @Body() dto: DeviceDto) {
    return this.engagement.registerDevice(user.sub, dto);
  }

  @Get('notification-preferences')
  preferences(@CurrentUser() user: JwtPayload) {
    return this.engagement.preferences(user.sub);
  }

  @Put('notification-preferences')
  setPreferences(@CurrentUser() user: JwtPayload, @Body() dto: PreferencesDto) {
    return this.engagement.setPreferences(user.sub, dto.preferences, dto.quiet_hours);
  }

  /** In-app notification inbox. */
  @Get('notifications')
  inbox(@CurrentUser() user: JwtPayload, @Query('unread') unread?: string) {
    return this.engagement.inbox(user.sub, unread === 'true');
  }

  @Post('notifications/:id/read')
  markRead(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.engagement.markRead(user.sub, id);
  }

  @Post('notifications/read-all')
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.engagement.markAllRead(user.sub);
  }
}
