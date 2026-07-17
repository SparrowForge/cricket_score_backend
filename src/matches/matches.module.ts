import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module';
import { SaasModule } from '../saas/saas.module';
import { LiveStateService } from './live-state.service';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';
import { ScoringService } from './scoring.service';
import { StatsService } from './stats.service';

@Module({
  imports: [SaasModule, EngagementModule],
  controllers: [MatchesController],
  providers: [MatchesService, ScoringService, StatsService, LiveStateService],
  exports: [StatsService, LiveStateService],
})
export class MatchesModule {}
