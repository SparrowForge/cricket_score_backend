import { Module } from '@nestjs/common';
import { SaasModule } from '../saas/saas.module';
import { FormatsController, OfficialsController, PlayersController, TeamsController, VenuesController } from './catalog.controllers';
import { CatalogService } from './catalog.service';

@Module({
  imports: [SaasModule],
  controllers: [FormatsController, OfficialsController, VenuesController, TeamsController, PlayersController],
  providers: [CatalogService],
})
export class CatalogModule {}
