import { Module } from '@nestjs/common';
import { MatchesModule } from '../matches/matches.module';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [MatchesModule],
  providers: [LiveGateway],
})
export class RealtimeModule {}
