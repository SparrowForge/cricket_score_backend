/* eslint-disable no-console */
/** Verifies external service credentials: Neon (query), Cloudinary (ping), SMTP (verify). */
const fs = require('fs');
const path = require('path');

(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

async function main() {
  let failures = 0;

  // Postgres
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(`SELECT current_database() AS db,
      (SELECT count(*)::int FROM roles) AS roles,
      (SELECT count(*)::int FROM match_formats) AS formats,
      (SELECT count(*)::int FROM subscription_plans) AS plans`);
    console.log(`✔ Postgres: db=${r.rows[0].db} roles=${r.rows[0].roles} formats=${r.rows[0].formats} plans=${r.rows[0].plans}`);
    await c.end();
  } catch (e) { failures++; console.error(`✘ Postgres: ${e.message}`); }

  // Cloudinary
  try {
    const { v2: cloudinary } = require('cloudinary');
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const pong = await cloudinary.api.ping();
    console.log(`✔ Cloudinary: ${pong.status} (cloud: ${process.env.CLOUDINARY_CLOUD_NAME})`);
  } catch (e) { failures++; console.error(`✘ Cloudinary: ${e.error?.message ?? e.message}`); }

  // SMTP
  try {
    const nodemailer = require('nodemailer');
    // Mirror MailService: TLS mode follows the port (465 implicit, 587
    // STARTTLS) rather than SMTP_SECURE, so the smoke test can't pass while
    // the app fails on a stale flag. Self-signed is opt-in the same way —
    // shared-hosting mail servers present a cert for the box's own hostname.
    const port = Number(process.env.SMTP_PORT ?? 587);
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      ...(process.env.SMTP_ALLOW_SELF_SIGNED === 'true'
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    });
    await t.verify();
    console.log(`✔ SMTP: authenticated as ${process.env.SMTP_USER} @ ${process.env.SMTP_HOST}`);
  } catch (e) { failures++; console.error(`✘ SMTP: ${e.message}`); }

  process.exit(failures ? 1 : 0);
}
main();
