import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    try {
      req.user = await this.jwt.verifyAsync<JwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
