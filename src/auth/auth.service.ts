import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { MailService } from '../mail/mail.service';
import { RegisterDto, LoginDto } from './dto';

@Injectable()
export class AuthService {
  private readonly googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  async register(dto: RegisterDto) {
    if (!dto.terms_accepted) {
      throw new BadRequestException('You must accept the CricLive terms to create an account.');
    }

    const password_hash = await bcrypt.hash(dto.password, 12);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, full_name, status, email_verified_at)
         VALUES ($1, $2, $3, 'active', now())
         ON CONFLICT (email) DO NOTHING
         RETURNING id, email, full_name`,
        [dto.email, password_hash, dto.full_name],
      );
      if (inserted.rowCount === 0) throw new ConflictException('An account with this email already exists');
      const user = inserted.rows[0];
      await this.assignDefaultRole(client, user.id);
      await client.query('COMMIT');

      void this.mail.sendWelcome(user.email, user.full_name); // fire-and-forget
      return this.issueToken(user.id, user.email);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Verifies a Google Identity Services credential, then signs in (linking by email) or registers the user. */
  async googleLogin(idToken: string) {
    let payload;
    try {
      const ticket = await this.googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid Google credential');
    }
    if (!payload?.email) throw new UnauthorizedException('Google account has no email');
    if (!payload.email_verified) throw new UnauthorizedException('Google email is not verified');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = (
        await client.query(
          `SELECT id, status FROM users WHERE (google_id = $1 OR email = $2) AND deleted_at IS NULL`,
          [payload.sub, payload.email],
        )
      ).rows[0];

      let userId: string;
      if (existing) {
        if (existing.status === 'suspended') throw new UnauthorizedException('Account suspended');
        userId = existing.id;
        await client.query(
          `UPDATE users SET google_id = $2, avatar_url = coalesce(avatar_url, $3), email_verified_at = coalesce(email_verified_at, now())
           WHERE id = $1`,
          [userId, payload.sub, payload.picture ?? null],
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO users (email, google_id, full_name, avatar_url, status, email_verified_at)
           VALUES ($1, $2, $3, $4, 'active', now()) RETURNING id`,
          [payload.email, payload.sub, payload.name ?? payload.email, payload.picture ?? null],
        );
        userId = inserted.rows[0].id;
        await this.assignDefaultRole(client, userId);
        void this.mail.sendWelcome(payload.email, payload.name ?? payload.email);
      }

      await client.query('COMMIT');
      await this.pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
      return this.issueToken(userId, payload.email);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Bootstrap: the very first user becomes super admin; everyone else is a viewer. */
  private async assignDefaultRole(client: PoolClient, userId: string) {
    const isFirst = (await client.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n === 1;
    const roleSlug = isFirst ? 'super_admin' : 'viewer';
    await client.query(
      `INSERT INTO user_role_assignments (user_id, role_id)
       SELECT $1, id FROM roles WHERE slug = $2 AND organization_id IS NULL`,
      [userId, roleSlug],
    );
  }

  async login(dto: LoginDto) {
    const res = await this.pool.query(
      `SELECT id, email, full_name, password_hash, status FROM users
       WHERE email = $1 AND deleted_at IS NULL`,
      [dto.email],
    );
    const user = res.rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(dto.password, user.password_hash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.status === 'suspended') throw new UnauthorizedException('Account suspended');

    await this.pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    return this.issueToken(user.id, user.email);
  }

  async me(userId: string) {
    const res = await this.pool.query(
      `SELECT u.id, u.email, u.full_name, u.avatar_url, u.status, u.created_at,
              coalesce(array_agg(r.slug) FILTER (WHERE r.slug IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
         AND (ura.expires_at IS NULL OR ura.expires_at > now())
       LEFT JOIN roles r ON r.id = ura.role_id
       WHERE u.id = $1
       GROUP BY u.id`,
      [userId],
    );
    return res.rows[0] ?? null;
  }

  async updateProfile(userId: string, dto: { full_name?: string; avatar_url?: string; phone?: string }) {
    const res = await this.pool.query(
      `UPDATE users SET full_name = coalesce($2, full_name), avatar_url = coalesce($3, avatar_url),
              phone = coalesce($4, phone)
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, email, full_name, avatar_url, phone`,
      [userId, dto.full_name ?? null, dto.avatar_url ?? null, dto.phone ?? null],
    );
    return res.rows[0];
  }

  async changePassword(userId: string, dto: { current_password: string; new_password: string }) {
    const user = (await this.pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId])).rows[0];
    if (!user?.password_hash || !(await bcrypt.compare(dto.current_password, user.password_hash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const hash = await bcrypt.hash(dto.new_password, 12);
    await this.pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hash]);
    return { changed: true };
  }

  /** Always answers {sent:true} — never reveals whether the email exists. */
  async forgotPassword(email: string) {
    const user = (
      await this.pool.query(`SELECT id, full_name FROM users WHERE email = $1 AND deleted_at IS NULL`, [email])
    ).rows[0];
    if (user) {
      const token = randomBytes(32).toString('hex');
      const hash = createHash('sha256').update(token).digest('hex');
      await this.pool.query(
        `UPDATE users SET metadata = metadata || jsonb_build_object('pwreset',
           jsonb_build_object('hash', $2::text, 'exp', (extract(epoch FROM now()) + 3600)::bigint))
         WHERE id = $1`,
        [user.id, hash],
      );
      const base = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
      const sent = await this.mail.sendPasswordReset(
        email,
        user.full_name,
        `${base}/reset-password?token=${token}&email=${encodeURIComponent(email)}`,
      );
      if (!sent) {
        throw new ServiceUnavailableException('We could not send the reset email right now. Please try again later.');
      }
    }
    return { sent: true };
  }

  async resetPassword(dto: { email: string; token: string; new_password: string }) {
    const user = (
      await this.pool.query(
        `SELECT id, metadata->'pwreset' AS pwreset FROM users WHERE email = $1 AND deleted_at IS NULL`,
        [dto.email],
      )
    ).rows[0];
    const hash = createHash('sha256').update(dto.token).digest('hex');
    if (!user?.pwreset || user.pwreset.hash !== hash || Number(user.pwreset.exp) < Date.now() / 1000) {
      throw new BadRequestException('Invalid or expired reset token');
    }
    const newHash = await bcrypt.hash(dto.new_password, 12);
    await this.pool.query(
      `UPDATE users SET password_hash = $2, metadata = metadata - 'pwreset' WHERE id = $1`,
      [user.id, newHash],
    );
    return { reset: true };
  }

  /** Resolved grants per scope — drives client-side menu/button gating. */
  async myPermissions(userId: string) {
    const res = await this.pool.query(
      `SELECT r.slug AS role, ura.organization_id, ura.tournament_id, ura.match_id, ura.expires_at,
              array_agg(p.resource || ':' || p.action ORDER BY p.resource, p.action) AS permissions
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ura.user_id = $1 AND (ura.expires_at IS NULL OR ura.expires_at > now())
       GROUP BY r.slug, ura.organization_id, ura.tournament_id, ura.match_id, ura.expires_at`,
      [userId],
    );
    return res.rows;
  }

  private async issueToken(userId: string, email: string) {
    const roles = await this.pool.query(
      `SELECT r.slug FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.user_id = $1 AND (ura.expires_at IS NULL OR ura.expires_at > now())`,
      [userId],
    );
    const access_token = await this.jwt.signAsync({
      sub: userId,
      email,
      roles: roles.rows.map((r) => r.slug),
    });
    return { access_token, token_type: 'Bearer', expires_in: process.env.JWT_EXPIRES_IN ?? '7d' };
  }
}
