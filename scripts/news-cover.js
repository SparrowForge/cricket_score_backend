#!/usr/bin/env node

/**
 * Renders a news cover image (2400x1350) from a JSON spec.
 *
 *   node scripts/news-cover.js <spec.json> <out.png>
 *
 * The spec drives an HTML card that is screenshotted with headless Chrome at
 * 1200x675 CSS pixels and a device scale factor of 2. Remote player photos are
 * inlined as data: URIs before the render — the headless run has no network
 * guarantees, and a cover that silently loses its faces is worse than one that
 * fails loudly.
 *
 * Palette is the site's dark theme (frontend/src/app/globals.css), so a cover
 * dropped on the news page does not read as a foreign object.
 *
 * Spec shape:
 * {
 *   "kicker": "MVP STANDINGS", "date": "5 SEPTEMBER 2026",
 *   "headline": ["KAYUM RECLAIMS", "THE SUMMIT"], "accent": 1,   // accent = gold line index
 *   "standfirst": "one or two lines",
 *   "chips": [{ "label": "MATCHES", "value": "36" }],
 *   "podium": [{ "name", "photo_url", "rating", "delta", "matches", "note" } x3],
 *   "flash": { "label": "FIRST HAT-TRICK", "text": "...", "sub": "..." },
 *   "footer": "criclive-score.com"
 * }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge binary found. Set CHROME_PATH.');
  return hit;
}

/** Photos become data: URIs so the render never depends on Cloudinary being reachable. */
function fetchDataUri(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const mime = res.headers['content-type'] || 'image/jpeg';
          resolve('data:' + mime + ';base64,' + Buffer.concat(chunks).toString('base64'));
        });
      })
      .on('error', () => resolve(null));
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function avatar(p, size, ring) {
  if (p.photo_data) {
    return '<img class="ava" style="width:' + size + 'px;height:' + size + 'px;box-shadow:0 0 0 3px ' + ring + '" src="' + p.photo_data + '" alt="">';
  }
  const initial = esc(String(p.name || '?').trim().charAt(0).toUpperCase());
  return '<span class="ava ini" style="width:' + size + 'px;height:' + size + 'px;font-size:' +
    Math.round(size * 0.4) + 'px;box-shadow:0 0 0 3px ' + ring + '">' + initial + '</span>';
}

function html(spec) {
  // Medal rings for the top three; anyone listed below them gets the muted line colour.
  const rings = ['#fbbf24', '#a8b3c4', '#cd7f32'];
  const ringOf = (i) => rings[i] || '#5f7196';
  const lead = spec.podium[0];
  const rest = spec.podium.slice(1);

  const restRows = rest.map((p, i) => `
      <div class="row">
        <span class="rank" style="color:${ringOf(i + 1)}">${i + 2}</span>
        ${avatar(p, 54, ringOf(i + 1) + '55')}
        <span class="rname">${esc(p.name)}</span>
        <span class="rpts">${esc(p.rating)}</span>
        <span class="rdelta">${esc(p.delta)}</span>
      </div>`).join('');

  const chips = (spec.chips || [])
    .map((c) => `<span class="chip">${esc(c.label)} <b>${esc(c.value)}</b></span>`)
    .join('');

  return `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:675px}
  body{font-family:"Segoe UI",ui-sans-serif,system-ui,Roboto,sans-serif;
       color:#e2e8f0;background:#0b1120;overflow:hidden}
  /* Two light sources: a warm gold wash behind the champion card on the right,
     a cool green one under the headline on the left. */
  .bg{position:absolute;inset:0;
    background:
      radial-gradient(900px 620px at 88% 20%, rgba(251,191,36,.20), transparent 62%),
      radial-gradient(760px 560px at 4% 86%, rgba(34,197,94,.16), transparent 60%),
      linear-gradient(155deg,#0d1526 0%,#0b1120 48%,#111c33 100%)}
  /* Faint seam arcs — a cricket ball read at 7% opacity, not a logo. */
  .seam{position:absolute;inset:0;opacity:.07}
  .grain{position:absolute;inset:0;opacity:.35;
    background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px);
    background-size:100% 4px}
  .wrap{position:relative;height:100%;padding:44px 52px;display:flex;flex-direction:column}

  .rail{display:flex;align-items:center;gap:16px;font-size:15px;letter-spacing:.16em;font-weight:800}
  .dot{width:11px;height:11px;border-radius:99px;background:#22c55e;box-shadow:0 0 16px #22c55e}
  .kicker{color:#22c55e}
  .sep{flex:1;height:1px;background:linear-gradient(90deg,#24304d,transparent)}
  .date{color:#8b9cbe;letter-spacing:.14em}

  .body{flex:1;display:flex;gap:44px;align-items:center;padding-top:6px}
  .left{width:508px}
  .headline{font-size:69px;line-height:.94;font-weight:900;letter-spacing:-.028em}
  .headline em{font-style:normal;color:#fbbf24}
  .standfirst{margin-top:22px;font-size:19px;line-height:1.5;color:#a9b8d4;max-width:520px}
  .chips{margin-top:26px;display:flex;gap:10px}
  .chip{border:1px solid #24304d;background:rgba(26,37,64,.7);border-radius:99px;
    padding:8px 16px;font-size:13.5px;font-weight:800;color:#a9b8d4;letter-spacing:.05em}
  .chip b{color:#e2e8f0;font-variant-numeric:tabular-nums}

  .right{flex:1;display:flex;flex-direction:column;gap:11px}
  .champ{position:relative;border:1px solid rgba(251,191,36,.34);border-radius:22px;padding:24px 26px;
    background:linear-gradient(140deg,rgba(251,191,36,.17),rgba(19,28,46,.9) 62%);
    display:flex;align-items:center;gap:22px;overflow:hidden}
  .champ:after{content:"";position:absolute;right:-70px;top:-70px;width:230px;height:230px;
    border-radius:99px;background:radial-gradient(circle,rgba(251,191,36,.28),transparent 68%)}
  .ava{border-radius:99px;object-fit:cover;flex:none;background:#1a2540;
    display:inline-grid;place-items:center;color:#8b9cbe;font-weight:900}
  .cmeta{flex:1;min-width:0;position:relative}
  .crown{font-size:12px;font-weight:900;letter-spacing:.2em;color:#fbbf24}
  .cname{margin-top:5px;font-size:28px;font-weight:900;line-height:1.05;letter-spacing:-.02em}
  .csub{margin-top:7px;font-size:14px;color:#8b9cbe;font-variant-numeric:tabular-nums}
  .cpts{text-align:right;position:relative;flex:none}
  .cpts .v{font-size:52px;font-weight:900;color:#fbbf24;line-height:1;
    font-variant-numeric:tabular-nums;letter-spacing:-.03em}
  .cpts .l{margin-top:6px;font-size:11px;font-weight:800;letter-spacing:.16em;color:#8b9cbe}
  .cpts .d{margin-top:8px;font-size:16px;font-weight:900;color:#22c55e;font-variant-numeric:tabular-nums}

  .row{display:flex;align-items:center;gap:16px;border:1px solid #24304d;border-radius:16px;
    padding:11px 20px;background:rgba(19,28,46,.72)}
  .rank{font-size:22px;font-weight:900;width:20px;font-variant-numeric:tabular-nums}
  .rname{flex:1;font-size:20px;font-weight:800;letter-spacing:-.01em;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  .rpts{font-size:25px;font-weight:900;font-variant-numeric:tabular-nums}
  .rdelta{width:92px;text-align:right;font-size:15px;font-weight:800;color:#22c55e;
    font-variant-numeric:tabular-nums}

  .flash{margin-top:6px;display:flex;align-items:center;gap:18px;
    border-top:1px solid #24304d;padding-top:20px}
  .flabel{flex:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:900;
    letter-spacing:.14em;color:#0b1120;background:#ef4444}
  .ftext{font-size:19px;font-weight:700;color:#e2e8f0}
  .ftext span{color:#8b9cbe;font-weight:600}
  .foot{margin-left:auto;font-size:14px;font-weight:800;letter-spacing:.14em;color:#5f7196}
</style>
<div class="bg"></div>
<svg class="seam" viewBox="0 0 1200 675" preserveAspectRatio="none">
  <path d="M-60 690 C 240 470, 470 300, 1260 175" fill="none" stroke="#e2e8f0" stroke-width="2"
        stroke-dasharray="16 22" stroke-linecap="round"/>
  <path d="M-60 745 C 250 525, 480 355, 1260 230" fill="none" stroke="#e2e8f0" stroke-width="2"
        stroke-dasharray="16 22" stroke-linecap="round"/>
</svg>
<div class="grain"></div>
<div class="wrap">
  <div class="rail">
    <span class="dot"></span><span>CRICLIVE</span>
    <span class="kicker">${esc(spec.kicker)}</span>
    <span class="sep"></span>
    <span class="date">${esc(spec.date)}</span>
  </div>

  <div class="body">
    <div class="left">
      <div class="headline">${spec.headline.map((l, i) => (i === spec.accent ? '<em>' + esc(l) + '</em>' : esc(l))).join('<br>')}</div>
      <div class="standfirst">${esc(spec.standfirst)}</div>
      <div class="chips">${chips}</div>
    </div>

    <div class="right">
      <div class="champ">
        ${avatar(lead, 108, 'rgba(251,191,36,.55)')}
        <div class="cmeta">
          <div class="crown">&#9733; MVP LEADER</div>
          <div class="cname">${esc(lead.name)}</div>
          <div class="csub">${esc(lead.matches)} matches &middot; ${esc(lead.note)}</div>
        </div>
        <div class="cpts">
          <div class="v">${esc(lead.rating)}</div>
          <div class="l">MVP POINTS</div>
          <div class="d">${esc(lead.delta)}</div>
        </div>
      </div>
      ${restRows}
    </div>
  </div>

  <div class="flash">
    <span class="flabel">${esc(spec.flash.label)}</span>
    <span class="ftext">${esc(spec.flash.text)} <span>${esc(spec.flash.sub)}</span></span>
    <span class="foot">${esc(spec.footer || 'criclive-score.com')}</span>
  </div>
</div>`;
}

(async () => {
  const [specPath, outPath] = process.argv.slice(2);
  if (!specPath || !outPath) {
    console.error('usage: node scripts/news-cover.js <spec.json> <out.png>');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  for (const p of spec.podium) p.photo_data = await fetchDataUri(p.photo_url);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'news-cover-'));
  const htmlPath = path.join(tmp, 'cover.html');
  fs.writeFileSync(htmlPath, html(spec));

  const out = path.resolve(outPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(
    findChrome(),
    [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
      '--force-device-scale-factor=2',
      '--window-size=1200,675',
      '--screenshot=' + out,
      '--user-data-dir=' + path.join(tmp, 'profile'),
      'file:///' + htmlPath.replace(/\\/g, '/'),
    ],
    { stdio: 'ignore' },
  );

  if (!fs.existsSync(out)) throw new Error('Chrome produced no screenshot');
  console.log(out + '  (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');
})().catch((e) => { console.error(e.message); process.exit(1); });
