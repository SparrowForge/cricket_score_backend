import { Module } from '@nestjs/common';
import { PlansController, SubscriptionsController } from './saas.controller';
import { SaasService } from './saas.service';

@Module({
  controllers: [PlansController, SubscriptionsController],
  providers: [SaasService],
  exports: [SaasService],
})
export class SaasModule {}
