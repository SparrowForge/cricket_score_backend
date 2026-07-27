/**
 * cPanel / Phusion Passenger entry point.
 *
 * Loads .env from THIS directory before booting Nest, so the app never depends
 * on Passenger's working directory — and, more importantly, so secrets with
 * spaces, braces or newlines (FIREBASE_SERVICE_ACCOUNT, SMTP_PASS) never have
 * to go through cPanel's "Environment variables" UI. cPanel bakes those into a
 * shell wrapper as unquoted `export` statements, which corrupts them.
 *
 * Passenger ignores the port passed to listen(); it hands the app its own socket.
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (key in process.env) continue; // real env wins
    // Strip matched surrounding quotes, but leave inner \n escapes untouched —
    // FIREBASE_SERVICE_ACCOUNT is JSON.parse'd downstream and needs them intact.
    process.env[key] = rawValue.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
} else {
  console.warn(`[startup] no .env at ${envPath} — relying on process environment`);
}

require('./dist/main.js');
