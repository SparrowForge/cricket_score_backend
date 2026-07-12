import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto, RegisterDto } from './dto';

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @IsString() avatar_url?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

class ChangePasswordDto {
  @IsString() @IsNotEmpty() current_password!: string;
  @IsString() @MinLength(8) @MaxLength(128) new_password!: string;
}

class ForgotPasswordDto {
  @IsEmail() email!: string;
}

class ResetPasswordDto {
  @IsEmail() email!: string;
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @MinLength(8) @MaxLength(128) new_password!: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: any) {
    return this.auth.me(req.user.sub);
  }

  /** Update profile (name / avatar / phone). */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(req.user.sub, dto);
  }

  /** Resolved permission grants per scope — use to gate admin UI. */
  @Get('me/permissions')
  @UseGuards(JwtAuthGuard)
  myPermissions(@Req() req: any) {
    return this.auth.myPermissions(req.user.sub);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.sub, dto);
  }

  /** Sends a reset link by email. Always returns {sent:true}. */
  @Post('forgot-password')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }
}
