import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/public.decorator';
import { ContactRequestType, ContactService } from './contact.service';

class ContactDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsEmail() @MaxLength(160) email!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(160) organization?: string;
  @IsOptional() @IsIn(['schedule', 'demo', 'pricing', 'support', 'other']) request_type?: ContactRequestType;
  /** Free text on purpose: "first weekend of March" is a useful answer too. */
  @IsOptional() @IsString() @MaxLength(120) preferred_date?: string;
  @IsString() @MinLength(10) @MaxLength(4000) message!: string;
  /** Honeypot — hidden in the form, so anything here means a bot. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

@ApiTags('Contact')
@Controller()
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  /**
   * Public contact / schedule-request form. Mails the enquiry to the CricLive
   * inbox with the sender as reply-to.
   *
   * Five an hour per IP: this is an unauthenticated endpoint that sends mail,
   * which is a spam relay if left open, and no human fills it in six times.
   */
  @Public()
  @Post('contact')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  submit(@Body() dto: ContactDto) {
    return this.contact.submit(dto);
  }
}
