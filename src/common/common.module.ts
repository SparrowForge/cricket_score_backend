import { Global, Module } from '@nestjs/common';
import { AccessService } from './auth';

@Global()
@Module({
  providers: [AccessService],
  exports: [AccessService],
})
export class CommonModule {}
