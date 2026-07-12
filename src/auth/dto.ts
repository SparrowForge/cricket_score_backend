import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

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
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
