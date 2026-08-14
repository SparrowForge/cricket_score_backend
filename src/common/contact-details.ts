/**
 * The public-facing contact details, in one place: the enquiry inbox that
 * receives form submissions and the number quoted back in the acknowledgement.
 *
 * Must stay in step with what the site shows (`frontend/src/lib/contact.ts`) —
 * an acknowledgement quoting a different number than the page the visitor just
 * filled in reads as a phishing attempt.
 */
export const CONTACT_INBOX = process.env.CONTACT_EMAIL ?? 'contact@criclive-score.com';
export const CONTACT_PHONE = process.env.CONTACT_PHONE ?? '01720262326';
