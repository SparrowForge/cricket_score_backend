import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/**
 * Fail fast. Nodemailer's stock timeouts run to ~2 minutes, which on a host
 * that silently drops outbound SMTP means every mail-sending request hangs for
 * two minutes and then logs nothing useful. Ten seconds is far longer than a
 * reachable SMTP server needs and short enough to fall back while the caller
 * is still waiting.
 */
const SMTP_TIMEOUT_MS = 10_000;

/** Connection-level failures — the server was never reached, so a retry on the
 *  alternate port is worth attempting. Auth/recipient errors are NOT here:
 *  those repeat identically on any port. */
const CONNECTION_ERRORS = new Set([
  'ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'EHOSTUNREACH',
]);

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  private readonly host = process.env.SMTP_HOST;
  private readonly primaryPort = Number(process.env.SMTP_PORT ?? 587);
  /** 587 (STARTTLS) and 465 (implicit TLS) are the two submission ports; when
   *  one is blocked the other frequently is not, so each is the other's
   *  fallback. Port 25 is deliberately never tried — every major PaaS blocks
   *  it outright and it is not a submission port. */
  private readonly fallbackPort = this.primaryPort === 465 ? 587 : 465;

  private readonly transporter = this.buildTransport(this.primaryPort);
  private fallbackTransporter: nodemailer.Transporter | null = null;
  /** Set once the primary port has proven unreachable, so later sends skip
   *  straight to the port that works instead of eating the timeout each time. */
  private useFallback = false;

  private readonly from = `"${process.env.FROM_NAME ?? 'CricLive'}" <${process.env.FROM_EMAIL}>`;

  /**
   * Optional HTTPS transport. Render's free instances block outbound 25/465/587
   * outright (since Sept 2025), and most PaaS free tiers do the same, so on
   * those hosts NO amount of SMTP tuning will connect. Setting RESEND_API_KEY
   * routes mail over plain HTTPS instead, which is never blocked. Unset, this
   * changes nothing and SMTP is used exactly as before.
   */
  private readonly resendKey = process.env.RESEND_API_KEY;

  constructor() {
    if (this.resendKey) {
      this.logger.log('Mail transport: Resend HTTPS API (SMTP bypassed).');
      return;
    }
    if (!this.host) {
      this.logger.warn('SMTP_HOST is not set — outgoing mail is disabled.');
      return;
    }
    // Probe at boot so a blocked port shows up in the deploy log rather than
    // as a silently missing password-reset email days later.
    void this.transporter
      .verify()
      .then(() => this.logger.log(`SMTP ready — ${this.host}:${this.primaryPort}`))
      .catch((err: NodeJS.ErrnoException) => {
        this.logger.error(
          `SMTP connection to ${this.host}:${this.primaryPort} failed at startup (${err.code ?? 'unknown'}: ${err.message}). ` +
            `Will fall back to port ${this.fallbackPort} on first send. ` +
            'If both ports fail, this host is blocking outbound SMTP — use an HTTP email API instead.',
        );
      });
  }

  /**
   * `secure` is a property of the port, not a free choice: 465 speaks TLS from
   * the first byte, 587 starts in the clear and upgrades via STARTTLS. Deriving
   * it here removes a whole class of misconfiguration (a stale SMTP_SECURE=false
   * against port 465 hangs forever, since the server is waiting for a TLS
   * handshake that never comes).
   */
  private buildTransport(port: number): nodemailer.Transporter {
    const options: SMTPTransport.Options = {
      host: this.host,
      port,
      secure: port === 465,
      requireTLS: port !== 465, // refuse to send in the clear if STARTTLS is unavailable
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      dnsTimeout: SMTP_TIMEOUT_MS,
    };
    return nodemailer.createTransport(options);
  }

  private get fallback(): nodemailer.Transporter {
    this.fallbackTransporter ??= this.buildTransport(this.fallbackPort);
    return this.fallbackTransporter;
  }

  /** Connection/auth check used by the smoke test — sends nothing. */
  verifyConnection(): Promise<true> {
    return this.transporter.verify();
  }

  async send(to: string, subject: string, html: string, text?: string): Promise<boolean> {
    if (this.resendKey) return this.sendOverHttp(to, subject, html, text);
    if (!this.host) {
      this.logger.error(`Cannot send "${subject}" to ${to}: SMTP_HOST is not configured.`);
      return false;
    }
    const message = { from: this.from, to, subject, html, text };

    try {
      const transport = this.useFallback ? this.fallback : this.transporter;
      return this.report(await transport.sendMail(message), to, subject);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;

      // Couldn't reach the server on the primary port — try the other
      // submission port once before giving up.
      if (!this.useFallback && CONNECTION_ERRORS.has(e.code ?? '')) {
        this.logger.warn(
          `SMTP ${this.host}:${this.primaryPort} unreachable (${e.code}) — retrying on ${this.fallbackPort}.`,
        );
        try {
          const info = await this.fallback.sendMail(message);
          this.useFallback = true; // stick with what works
          this.logger.log(`SMTP fallback to port ${this.fallbackPort} succeeded — using it from now on.`);
          return this.report(info, to, subject);
        } catch (fallbackErr) {
          const f = fallbackErr as NodeJS.ErrnoException;
          this.logger.error(
            `Both SMTP ports failed for "${subject}" to ${to} ` +
              `(${this.primaryPort}: ${e.code ?? e.message}, ${this.fallbackPort}: ${f.code ?? f.message}). ` +
              'This host is almost certainly blocking outbound SMTP — switch to an HTTP email API.',
          );
          return false;
        }
      }

      // Mail must never break a request path; failures are logged for retry tooling.
      this.logger.error(`Failed to send "${subject}" to ${to}: ${e.code ? `${e.code}: ` : ''}${e.message}`);
      return false;
    }
  }

  /** Deliver over HTTPS instead of SMTP — see `resendKey`. */
  private async sendOverHttp(to: string, subject: string, html: string, text?: string): Promise<boolean> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: this.from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(SMTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.error(
          `Resend rejected "${subject}" for ${to}: ${res.status} ${await res.text().catch(() => '')}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to send "${subject}" to ${to} via Resend: ${(err as Error).message}`);
      return false;
    }
  }

  private report(info: nodemailer.SentMessageInfo, to: string, subject: string): boolean {
    if ((info.rejected?.length ?? 0) > 0) {
      this.logger.error(`SMTP rejected "${subject}" for ${to}: ${info.response ?? 'no response'}`);
      return false;
    }
    return true;
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
