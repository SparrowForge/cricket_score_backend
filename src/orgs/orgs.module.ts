import { Module } from '@nestjs/common';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';
import { PublicClubsController } from './public-clubs.controller';
import { RbacController } from './rbac.controller';

@Module({
  controllers: [OrgsController, RbacController, PublicClubsController],
  providers: [OrgsService],
})
export class OrgsModule {}
