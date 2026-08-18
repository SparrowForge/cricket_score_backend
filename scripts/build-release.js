#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Build a deployable release bundle for cPanel / Phusion Passenger.
 *
 *   npm run release
 *
 * Why this exists: `dist/` is gitignored, so the server CANNOT get the built
 * code from git. The backend is deployed by uploading built output, and it is
 * easy to upload the wrong set of files — miss `app.js` and Passenger has no
 * entry point; miss `package.json` and cPanel cannot install dependencies;
 * include `.env` and you overwrite the server's live secrets with your local
 * ones.
 *
 * This stages exactly the right files into `release/` and refuses to include
 * `.env`, so the bundle is safe to hand to anyone or drop in a zip.
 *
 * It does NOT upload anything. Uploading and restarting stay manual on purpose
 * — a bad restart takes the live API down mid-match.
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release');

/** Everything the server needs, and nothing it does not. */
const INCLUDE = [
  { src: 'dist', required: true, note: 'compiled application' },
  { src: 'app.js', required: true, note: 'Passenger entry point — hand-written, never generated' },
  { src: 'package.json', required: true, note: 'so cPanel can install dependencies' },
  { src: 'package-lock.json', required: false, note: 'pins the dependency tree' },
  { src: 'migrations', required: false, note: 'only needed if you run db:migrate on the server' },
];

/**
 * Never shipped. `.env` holds PRODUCTION Neon and Upstash credentials and the
 * server already has its own copy — overwriting it is how you take the API down
 * with a stale secret.
 */
const NEVER = ['.env', '.env.local', 'node_modules', 'src', 'release'];

const step = (msg) => console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const die = (msg) => { console.error(`\n\x1b[31m✘ ${msg}\x1b[0m\n`); process.exit(1); };

function dirStats(p) {
  let files = 0; let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { files += 1; bytes += fs.statSync(full).size; }
    }
  };
  const st = fs.statSync(p);
  if (st.isDirectory()) walk(p); else { files = 1; bytes = st.size; }
  return { files, bytes };
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------- 1. build
step('Compiling TypeScript (nest build)');
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
} catch {
  die('Build failed — fix the errors above before releasing.');
}

const mainJs = path.join(ROOT, 'dist', 'main.js');
if (!fs.existsSync(mainJs)) die('dist/main.js is missing after the build. Nothing to release.');
ok('dist/main.js present');

// ------------------------------------------------------------ 2. sanity
step('Checking the bundle is safe to ship');

// app.js is hand-written and load-bearing; the root CLAUDE.md calls it out
// explicitly as "do not delete". A release without it boots nothing.
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
if (!appJs.includes("require('./dist/main.js')")) {
  die('app.js no longer requires ./dist/main.js — Passenger would boot nothing.');
}
ok('app.js still points at dist/main.js');

// -------------------------------------------------------------- 3. stage
step('Staging release/');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = [];
for (const item of INCLUDE) {
  const from = path.join(ROOT, item.src);
  if (!fs.existsSync(from)) {
    if (item.required) die(`Required file missing: ${item.src}`);
    warn(`skipped ${item.src} (not present) — ${item.note}`);
    continue;
  }
  fs.cpSync(from, path.join(OUT, item.src), { recursive: true });
  const { files, bytes } = dirStats(from);
  manifest.push({ path: item.src, files, bytes, note: item.note });
  ok(`${item.src.padEnd(18)} ${String(files).padStart(4)} file(s)  ${mb(bytes).padStart(9)}`);
}

// Belt and braces: prove none of the excluded paths made it in.
for (const bad of NEVER) {
  if (fs.existsSync(path.join(OUT, bad))) die(`${bad} ended up in the bundle — refusing to continue.`);
}
ok(`excluded: ${NEVER.join(', ')}`);

// ----------------------------------------------------------- 4. manifest
const total = manifest.reduce((a, m) => ({ files: a.files + m.files, bytes: a.bytes + m.bytes }), { files: 0, bytes: 0 });
const stamp = new Date().toISOString();
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a git repo */ }

fs.writeFileSync(path.join(OUT, 'MANIFEST.txt'),
  [
    'CricLive backend release bundle',
    `built    ${stamp}`,
    `commit   ${commit}`,
    `contents ${total.files} files, ${mb(total.bytes)}`,
    '',
    ...manifest.map((m) => `  ${m.path.padEnd(20)} ${String(m.files).padStart(5)} files  ${mb(m.bytes).padStart(9)}  ${m.note}`),
    '',
    'NOT included (deliberately): .env — the server keeps its own copy.',
    '',
    'Upload the CONTENTS of this folder into the cPanel app root, then restart',
    'the app (Setup Node.js App > Restart, or `touch tmp/restart.txt`).',
    '',
  ].join('\n'));

// -------------------------------------------------------------- 5. next
step('Done');
console.log(`  ${total.files} files, ${mb(total.bytes)} staged in  release/`);
console.log(`  commit ${commit}`);
console.log(`
  Deploy:
    1. Upload the CONTENTS of release/ into the cPanel application root,
       overwriting dist/ entirely (delete the old dist/ first — stale compiled
       files from a removed source file will otherwise linger and still load).
    2. Only if package.json changed:  npm install  in the app's Node terminal.
    3. cPanel > Setup Node.js App > Restart   (or: touch tmp/restart.txt)
    4. Verify:  curl https://api.criclive-score.com/health

  If the site then reports CORS or "failed to fetch", read
  https://api.criclive-score.com/stderr.log FIRST — a boot failure makes
  LiteSpeed serve its own 404 with no CORS headers, and the browser blames CORS.
`);
