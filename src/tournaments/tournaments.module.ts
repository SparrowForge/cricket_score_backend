import { Module } from '@nestjs/common';
import { MatchesModule } from '../matches/matches.module';
import { SaasModule } from '../saas/saas.module';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  imports: [SaasModule, MatchesModule],
  controllers: [TournamentsController],
  providers: [TournamentsService],
  exports: [TournamentsService],
})
export class TournamentsModule {}
