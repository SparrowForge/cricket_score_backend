#!/usr/bin/env node
/**
 * SMTP diagnostics — run this ON THE SERVER that sends the mail.
 *
 *   node scripts/mail-doctor.js              # probe only, sends nothing
 *   node scripts/mail-doctor.js you@mail.com # also sends one test message
 *
 * Why a separate script: when mail "doesn't work" the app can only tell you
 * that a send failed, and a blocked port fails identically to a wrong password
 * once the error is swallowed. This separates the three questions that actually
 * distinguish the causes:
 *
 *   1. Can this machine open a TCP socket to the mail host at all?   (egress)
 *   2. Does the SMTP conversation start and offer STARTTLS?          (protocol)
 *   3. Does the login succeed?                                       (credentials)
 *
 * It probes the configured host AND the local mail server, because on shared
 * cPanel hosting those usually have opposite outcomes: outbound connections to
 * an external provider are commonly blocked while the box's own mail server is
 * reachable, and the fix is to switch hosts rather than to keep tuning TLS.
 */
require('dotenv').config();
const net = require('net');
const nodemailer = require('nodemailer');

const TIMEOUT = 8000;
const PORTS = [587, 465, 25];

const cfgHost = process.env.SMTP_HOST;
const cfgPort = Number(process.env.SMTP_PORT ?? 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = `"${process.env.FROM_NAME ?? 'CricLive'}" <${process.env.FROM_EMAIL}>`;
const to = process.argv[2];

const pad = (s, n) => String(s).padEnd(n);

/** Raw TCP reachability — answers "is outbound blocked?" with no SMTP involved. */
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    const done = (result) => {
      sock.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    sock.setTimeout(TIMEOUT);
    sock.once('connect', () => done({ ok: true }));
    sock.once('timeout', () => done({ ok: false, err: 'timed out — almost always a firewall dropping outbound traffic' }));
    sock.once('error', (e) => done({ ok: false, err: `${e.code ?? e.message}` }));
    sock.connect(port, host);
  });
}

/** Full SMTP handshake + AUTH. */
async function smtpProbe(host, port) {
  const t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: TIMEOUT,
    tls: { rejectUnauthorized: false }, // self-signed certs are normal on cPanel boxes
  });
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code, err: e.message.split('\n')[0] };
  } finally {
    t.close();
  }
}

(async () => {
  console.log('\nSMTP DOCTOR');
  console.log('='.repeat(72));
  console.log(`configured host : ${cfgHost ?? '(SMTP_HOST not set)'}`);
  console.log(`configured port : ${cfgPort}`);
  console.log(`auth user       : ${user ?? '(none)'}`);
  console.log(`from address    : ${from}`);
  if (!cfgHost) {
    console.log('\nSMTP_HOST is not set — nothing to test.');
    process.exit(1);
  }

  // Distinct hosts worth trying: what's configured, plus the box's own mail
  // server under both the loopback and the conventional cPanel hostname.
  const domain = (process.env.FROM_EMAIL ?? '').split('@')[1];
  const hosts = [...new Set([cfgHost, 'localhost', domain && `mail.${domain}`].filter(Boolean))];

  const reachable = [];
  for (const host of hosts) {
    console.log(`\n--- ${host} ---`);
    for (const port of PORTS) {
      const tcp = await tcpProbe(host, port);
      if (!tcp.ok) {
        console.log(`  ${pad(port, 5)} TCP  FAIL  ${tcp.err} (${tcp.ms}ms)`);
        continue;
      }
      const smtp = await smtpProbe(host, port);
      if (smtp.ok) {
        console.log(`  ${pad(port, 5)} TCP  ok (${tcp.ms}ms)   SMTP+AUTH  OK`);
        reachable.push({ host, port });
      } else {
        console.log(`  ${pad(port, 5)} TCP  ok (${tcp.ms}ms)   SMTP  FAIL  ${smtp.code ?? ''} ${smtp.err}`);
      }
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  if (reachable.length === 0) {
    console.log('NOTHING WORKED.');
    console.log('Every port either refused or timed out. A timeout on all three ports');
    console.log('means this server blocks outbound SMTP — that is a hosting setting, not');
    console.log('a code problem. Ask the host to allow outbound 587/465, or send over an');
    console.log('HTTPS email API instead (set RESEND_API_KEY and mail bypasses SMTP).');
  } else {
    console.log('WORKING COMBINATIONS:');
    for (const r of reachable) console.log(`  SMTP_HOST=${r.host}  SMTP_PORT=${r.port}`);
    const cfgWorks = reachable.some((r) => r.host === cfgHost && r.port === cfgPort);
    console.log(cfgWorks
      ? '\nThe configured host/port works — if mail still is not arriving the send is\nsucceeding and delivery is the problem: check SPF/DKIM for the FROM domain,\nand the recipient spam folder.'
      : `\nThe configured ${cfgHost}:${cfgPort} is NOT among them. Switch SMTP_HOST/SMTP_PORT\nto one of the combinations above and restart the app.`);
  }

  if (to && reachable.length) {
    const { host, port } = reachable[0];
    console.log(`\nSending a test message via ${host}:${port} -> ${to} ...`);
    const t = nodemailer.createTransport({
      host, port, secure: port === 465, requireTLS: port !== 465,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: TIMEOUT,
      tls: { rejectUnauthorized: false },
    });
    try {
      const info = await t.sendMail({
        from, to,
        subject: 'CricLive SMTP test',
        text: `Sent from mail-doctor via ${host}:${port} at ${new Date().toISOString()}`,
      });
      console.log(`  accepted: ${JSON.stringify(info.accepted)}`);
      console.log(`  rejected: ${JSON.stringify(info.rejected)}`);
      console.log(`  response: ${info.response}`);
    } catch (e) {
      console.log(`  SEND FAILED  ${e.code ?? ''} ${e.message}`);
    } finally {
      t.close();
    }
  } else if (!to) {
    console.log('\nPass a recipient to also send a test message:');
    console.log('  node scripts/mail-doctor.js you@example.com');
  }
  console.log('');
})();
