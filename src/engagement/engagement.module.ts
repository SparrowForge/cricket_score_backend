import { Module } from '@nestjs/common';
import { EngagementController } from './engagement.controller';
import { EngagementService } from './engagement.service';
import { PushService } from './push.service';

@Module({
  controllers: [EngagementController],
  providers: [EngagementService, PushService],
  exports: [PushService],
})
export class EngagementModule {}
