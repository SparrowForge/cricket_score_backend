import { Module } from '@nestjs/common';
import { SaasModule } from '../saas/saas.module';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  imports: [SaasModule],
  controllers: [TournamentsController],
  providers: [TournamentsService],
  exports: [TournamentsService],
})
export class TournamentsModule {}
