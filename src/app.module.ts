import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { RealtimeModule } from './realtime/realtime.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { MediaModule } from './media/media.module';
import { MailModule } from './mail/mail.module';
import { OrgsModule } from './orgs/orgs.module';
import { SaasModule } from './saas/saas.module';
import { CatalogModule } from './catalog/catalog.module';
import { TournamentsModule } from './tournaments/tournaments.module';
import { MatchesModule } from './matches/matches.module';
import { ContactModule } from './contact/contact.module';
import { ContentModule } from './content/content.module';
import { EngagementModule } from './engagement/engagement.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    RedisModule,
    CommonModule,
    MailModule,
    AuthModule,
    MediaModule,
    OrgsModule,
    SaasModule,
    CatalogModule,
    TournamentsModule,
    MatchesModule,
    ContentModule,
    ContactModule,
    EngagementModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
