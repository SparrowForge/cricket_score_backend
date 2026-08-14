import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MailService } from '../mail/mail.service';

/** Where enquiries land. Overridable so a staging deploy can point elsewhere. */
const INBOX = process.env.CONTACT_EMAIL ?? 'contact@criclive-score.com';
/** Shown to the sender when mail is down, so the enquiry is not simply lost. */
const PHONE = process.env.CONTACT_PHONE ?? '01720262326';

export type ContactRequestType = 'schedule' | 'demo' | 'pricing' | 'support' | 'other';

export interface ContactRequest {
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  request_type?: ContactRequestType;
  preferred_date?: string;
  message: string;
  /** Honeypot: a real browser never fills this, bots fill everything. */
  website?: string;
}

const SUBJECTS: Record<ContactRequestType, string> = {
  schedule: 'Schedule request',
  demo: 'Demo request',
  pricing: 'Pricing enquiry',
  support: 'Support request',
  other: 'Website enquiry',
};

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(private readonly mail: MailService) {}

  async submit(dto: ContactRequest) {
    // Bots fill every field they can see. Answer exactly as we would a real
    // submission — telling a scraper it was filtered just teaches it the trick.
    if (dto.website?.trim()) {
      this.logger.warn(`Contact form honeypot tripped by ${dto.email}`);
      return { sent: true };
    }

    const type = dto.request_type ?? 'other';
    const rows: [string, string | undefined][] = [
      ['Name', dto.name],
      ['Email', dto.email],
      ['Phone', dto.phone],
      ['Organization', dto.organization],
      ['Request', SUBJECTS[type]],
      ['Preferred date', dto.preferred_date],
    ];

    const text = [
      ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
      '',
      dto.message,
    ].join('\n');

    const html = `
      <h2>${escapeHtml(SUBJECTS[type])}</h2>
      <table style="border-collapse:collapse;font-size:14px">
        ${rows
          .filter(([, v]) => v)
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td>
                   <td style="padding:4px 0;font-weight:600">${escapeHtml(v!)}</td></tr>`,
          )
          .join('')}
      </table>
      <p style="white-space:pre-wrap;margin-top:16px">${escapeHtml(dto.message)}</p>`;

    // Reply-to is the enquirer, so answering the notification reaches them
    // rather than the no-reply sender the SMTP account authenticates as.
    const sent = await this.mail.send(
      INBOX,
      `[CricLive] ${SUBJECTS[type]} — ${dto.name}`,
      html,
      text,
      dto.email,
    );

    if (!sent) {
      // Nothing is persisted, so a silent failure would drop the enquiry
      // entirely. Hand back the direct channels instead.
      this.logger.error(`Contact form send failed for ${dto.email} (${type})`);
      throw new ServiceUnavailableException(
        `We could not send your message just now. Please email ${INBOX} or call ${PHONE} and we will pick it up straight away.`,
      );
    }
    return { sent: true };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
