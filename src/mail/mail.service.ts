import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  private readonly from = `"${process.env.FROM_NAME ?? 'CricLive'}" <${process.env.FROM_EMAIL}>`;

  /** Connection/auth check used by the smoke test — sends nothing. */
  verifyConnection(): Promise<true> {
    return this.transporter.verify();
  }

  async send(to: string, subject: string, html: string, text?: string): Promise<boolean> {
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html, text });
      if ((info.rejected?.length ?? 0) > 0) {
        this.logger.error(`SMTP rejected "${subject}" for ${to}: ${info.response ?? 'no response'}`);
        return false;
      }
      return true;
    } catch (err) {
      // Mail must never break a request path; failures are logged for retry tooling.
      this.logger.error(`Failed to send "${subject}" to ${to}: ${(err as Error).message}`);
      return false;
    }
  }

  async sendWelcome(to: string, name: string): Promise<boolean> {
    const text = [
      `Welcome, ${name}!`,
      '',
      'Your CricLive account is ready. You can now create tournaments, manage teams and score matches ball-by-ball in real time.',
      '',
      `Open CricLive: ${process.env.FRONTEND_URL ?? '#'}`,
    ].join('\n');

    return this.send(
      to,
      'Welcome to CricLive 🏏',
      this.layout(`
        <h2>Welcome, ${escapeHtml(name)}!</h2>
        <p>Your CricLive account is ready. You can now create tournaments,
           manage teams and score matches ball-by-ball in real time.</p>
        <p><a href="${process.env.FRONTEND_URL ?? '#'}" style="background:#16a34a;color:#fff;
           padding:10px 20px;border-radius:6px;text-decoration:none">Open CricLive</a></p>`),
      text,
    );
  }

  async sendPasswordReset(to: string, name: string, resetUrl: string): Promise<boolean> {
    const text = [
      `Hi ${name},`,
      '',
      'We received a request to reset your CricLive password. This link expires in 1 hour:',
      '',
      resetUrl,
      '',
      "If you didn't request this, you can safely ignore this email.",
    ].join('\n');

    return this.send(
      to,
      'Reset your CricLive password',
      this.layout(`
        <h2>Hi ${escapeHtml(name)},</h2>
        <p>We received a request to reset your password. This link expires in 1 hour.</p>
        <p><a href="${resetUrl}" style="background:#16a34a;color:#fff;padding:10px 20px;
           border-radius:6px;text-decoration:none">Reset password</a></p>
        <p style="color:#666">If you didn't request this, you can safely ignore this email.</p>`),
      text,
    );
  }

  private layout(body: string): string {
    return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;
      background:#f4f6f8;margin:0;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px">
        <div style="font-size:20px;font-weight:700;color:#16a34a;margin-bottom:16px">🏏 CricLive</div>
        ${body}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#999;font-size:12px">© ${new Date().getFullYear()} CricLive — live cricket scoring</p>
      </div></body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
