import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

// MailModule is @Global, so MailService needs no import here.
@Module({
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
