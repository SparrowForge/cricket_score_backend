import { Module } from '@nestjs/common';
import { CmsController, ContactController, NewsController } from './content.controllers';
import { ContentService } from './content.service';

@Module({
  controllers: [NewsController, CmsController, ContactController],
  providers: [ContentService],
})
export class ContentModule {}
