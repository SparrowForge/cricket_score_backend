import { Module } from '@nestjs/common';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';
import { RbacController } from './rbac.controller';

@Module({
  controllers: [OrgsController, RbacController],
  providers: [OrgsService],
})
export class OrgsModule {}
