import { Module } from '@nestjs/common';
import { EngagementController } from './engagement.controller';
import { EngagementService } from './engagement.service';

@Module({
  controllers: [EngagementController],
  providers: [EngagementService],
})
export class EngagementModule {}
