import { Equals, IsBoolean, IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  full_name!: string;

  @IsBoolean()
  @Equals(true, { message: 'You must accept the CricLive terms to create an account.' })
  terms_accepted!: boolean;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class GoogleLoginDto {
  /** Google Identity Services credential — a signed JWT, verified server-side. */
  @IsString()
  @IsNotEmpty()
  id_token!: string;
}
