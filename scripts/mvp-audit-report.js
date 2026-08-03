#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Generates the "MVP Audit, Top 3" HTML report.
 *
 * Every match total is rebuilt HERE, in JS, from the stored per-match facts and
 * ball data — deliberately not by re-reading match_mvp_points. The stored figure
 * is then compared against it, so a drift between buildMvpPoints() and the
 * published rules shows up as a mismatch rather than being papered over.
 *
 * Usage: node scripts/mvp-audit-report.js [outfile.html]
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true, max: 4 });
const OUT = process.argv[2] || path.join(__dirname, '..', 'docs', 'MVP_AUDIT_TOP3.html');
const MOTM_BONUS = 3;

const n2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (x) => x.toFixed(2);

/** Format-dependent batting milestone — mirrors buildMvpPoints(). */
function milestone(runs, o) {
  if (o <= 20) {
    if (runs >= 3 * o) return { pts: 16, need: 3 * o };
    if (runs >= 2.5 * o) return { pts: 12, need: 2.5 * o };
    if (runs >= 2 * o) return { pts: 8, need: 2 * o };
    if (runs >= 1.5 * o) return { pts: 4, need: 1.5 * o };
    return { pts: 0, need: 1.5 * o };
  }
  if (runs >= 2 * o) return { pts: 16, need: 2 * o };
  if (runs >= 1.6 * o) return { pts: 12, need: 1.6 * o };
  if (runs >= 1.4 * o) return { pts: 8, need: 1.4 * o };
  if (runs >= 1 * o) return { pts: 4, need: 1 * o };
  return { pts: 0, need: 1 * o };
}

function haul(w) {
  if (w >= 5) return 14;
  if (w === 4) return 10;
  if (w === 3) return 6;
  if (w === 2) return 3;
  return 0;
}

async function main() {
  const top = (await pool.query(
    `SELECT p.id, p.full_name, count(*)::int AS matches,
            round(sum(pms.mvp_points), 2)::float8 AS career_mvp
     FROM player_match_stats pms
     JOIN players p ON p.id = pms.player_id
     JOIN matches m ON m.id = pms.match_id AND m.status = 'completed'
     GROUP BY p.id, p.full_name
     ORDER BY sum(pms.mvp_points) DESC
     LIMIT 3`,
  )).rows;

  const ids = top.map((t) => t.id);

  const rows = (await pool.query(
    `WITH mt AS (
       SELECT m.id, m.scheduled_start, m.winner_team_id, m.player_of_match_id,
              ta.short_name AS a_short, tb.short_name AS b_short,
              coalesce((m.rules_snapshot->>'overs_per_innings')::numeric,
                       (SELECT max(i.max_overs)::numeric FROM innings i WHERE i.match_id = m.id),
                       20) AS o,
              (SELECT CASE WHEN sum(i.legal_balls) > 0
                           THEN sum(i.total_runs)::numeric * 6 / sum(i.legal_balls) ELSE 0 END
               FROM innings i WHERE i.match_id = m.id) AS mrr
       FROM matches m
       JOIN teams ta ON ta.id = m.team_a_id
       JOIN teams tb ON tb.id = m.team_b_id
       WHERE m.status = 'completed'
     ),
     victims AS (
       SELECT b.bowler_id AS player_id, i.match_id,
              sum(least(v.runs * 0.2, 4))::numeric AS victim_value
       FROM balls b
       JOIN innings i ON i.id = b.innings_id
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(b2.runs_batter), 0) AS runs FROM balls b2
         WHERE b2.innings_id = b.innings_id AND b2.striker_id = b.dismissed_player_id
           AND b2.seq <= b.seq AND NOT b2.is_superseded
       ) v
       WHERE b.is_wicket AND NOT b.is_superseded
         AND b.wicket_type NOT IN ('run_out','retired_hurt','retired_out','obstructing_field','timed_out')
       GROUP BY b.bowler_id, i.match_id
     ),
     ferr AS (
       SELECT ce.fielder_player_id AS player_id, i.match_id,
              count(*) FILTER (WHERE ce.body LIKE 'DROPPED CATCH!%')::int AS dropped,
              count(*) FILTER (WHERE ce.body LIKE 'RUN OUT MISSED!%')::int AS missed,
              count(*) FILTER (WHERE ce.body LIKE 'MISFIELD!%')::int AS misfields
       FROM commentary_entries ce
       JOIN innings i ON i.id = ce.innings_id
       WHERE ce.fielder_player_id IS NOT NULL
       GROUP BY ce.fielder_player_id, i.match_id
     )
     SELECT pms.player_id, pms.match_id,
            mt.scheduled_start, mt.a_short, mt.b_short,
            mt.o::float8 AS o, mt.mrr::float8 AS mrr,
            (mt.winner_team_id IS NOT NULL AND pms.team_id = mt.winner_team_id) AS won,
            (mt.player_of_match_id = pms.player_id) AS is_potm,
            pms.batted, pms.runs_scored, pms.balls_faced, pms.fours, pms.sixes,
            pms.balls_bowled, pms.runs_conceded, pms.wickets_taken, pms.maidens, pms.dot_balls,
            pms.catches, pms.stumpings, pms.run_outs,
            coalesce(v.victim_value, 0)::float8 AS victim_value,
            coalesce(fe.dropped, 0) AS dropped, coalesce(fe.missed, 0) AS missed,
            coalesce(fe.misfields, 0) AS misfields,
            mmp.batting_points::float8 AS s_bat, mmp.bowling_points::float8 AS s_bowl,
            mmp.fielding_points::float8 AS s_field, mmp.total_points::float8 AS s_total
     FROM player_match_stats pms
     JOIN mt ON mt.id = pms.match_id
     JOIN match_mvp_points mmp ON mmp.match_id = pms.match_id AND mmp.player_id = pms.player_id
     LEFT JOIN victims v ON v.player_id = pms.player_id AND v.match_id = pms.match_id
     LEFT JOIN ferr fe ON fe.player_id = pms.player_id AND fe.match_id = pms.match_id
     WHERE pms.player_id = ANY($1::uuid[])
     ORDER BY mt.scheduled_start, pms.match_id`,
    [ids],
  )).rows;

  let mismatches = 0;
  const byPlayer = new Map(ids.map((id) => [id, []]));

  for (const r of rows) {
    const o = Number(r.o);
    const mrr = Number(r.mrr);
    const factor = r.won ? 1.1 : 1.0;
    const terms = [];

    // ---- batting ----
    let bat = 0;
    if (r.runs_scored || r.batted) {
      bat += r.runs_scored;
      terms.push(['Runs', `${r.runs_scored} scored`, r.runs_scored, r.runs_scored ? 'pos' : 'zero']);
      if (r.fours) { bat += r.fours * 0.5; terms.push(['Fours', `${r.fours} × 0.5`, r.fours * 0.5, 'pos']); }
      if (r.sixes) { bat += r.sixes * 1; terms.push(['Sixes', `${r.sixes} × 1`, r.sixes, 'pos']); }
      const ms = milestone(r.runs_scored, o);
      bat += ms.pts;
      terms.push(['Milestone', ms.pts ? `${r.runs_scored} ≥ ${ms.need} needed` : `${r.runs_scored} of ${ms.need} needed`,
        ms.pts, ms.pts ? 'bonus' : 'zero']);
      if (r.batted && r.balls_faced > 0) {
        const adj = clamp((r.runs_scored - (r.balls_faced * mrr) / 6) * 0.5, -8, 8);
        bat += adj;
        terms.push(['Rate', `${r.runs_scored} vs ${f2((r.balls_faced * mrr) / 6)} par off ${r.balls_faced}b`,
          adj, adj >= 0 ? 'pos' : 'neg']);
      }
      const contrib = o > 0 ? r.runs_scored / o : 0;
      bat += contrib;
      terms.push(['Contribution', `${r.runs_scored} ÷ ${o} ov`, contrib, contrib ? 'pos' : 'zero']);
    }

    // ---- bowling ----
    let bowl = 0;
    if (r.balls_bowled > 0 || r.wickets_taken > 0) {
      bowl += r.wickets_taken * 6;
      terms.push(['Wickets', `${r.wickets_taken} × 6`, r.wickets_taken * 6, r.wickets_taken ? 'pos' : 'zero']);
      if (r.dot_balls) { bowl += r.dot_balls * 0.25; terms.push(['Dots', `${r.dot_balls} × 0.25`, r.dot_balls * 0.25, 'pos']); }
      if (r.maidens) { bowl += r.maidens * 4; terms.push(['Maidens', `${r.maidens} × 4`, r.maidens * 4, 'pos']); }
      const h = haul(r.wickets_taken);
      if (h) { bowl += h; terms.push(['Haul', `${r.wickets_taken} wickets`, h, 'bonus']); }
      if (r.balls_bowled > 0) {
        const adj = clamp(((r.balls_bowled * mrr) / 6 - r.runs_conceded) * 0.5, -8, 8);
        bowl += adj;
        terms.push(['Economy', `${r.runs_conceded} vs ${f2((r.balls_bowled * mrr) / 6)} par off ${r.balls_bowled}b`,
          adj, adj >= 0 ? 'pos' : 'neg']);
      }
      if (Number(r.victim_value)) {
        bowl += Number(r.victim_value);
        terms.push(['Batters removed', '0.2 × victim runs, +4 cap each', Number(r.victim_value), 'pos']);
      }
    }

    // ---- fielding ----
    let field = 0;
    const fparts = [];
    if (r.catches) { field += r.catches * 6; fparts.push(`${r.catches}c`); }
    if (r.stumpings) { field += r.stumpings * 8; fparts.push(`${r.stumpings}st`); }
    if (r.run_outs) { field += r.run_outs * 8; fparts.push(`${r.run_outs}ro`); }
    if (r.dropped) { field -= r.dropped * 3; fparts.push(`${r.dropped} dropped`); }
    if (r.missed) { field -= r.missed * 2; fparts.push(`${r.missed} missed RO`); }
    if (r.misfields) { field -= r.misfields * 1; fparts.push(`${r.misfields} misfield`); }
    if (fparts.length) terms.push(['Fielding', fparts.join(' · '), field, field >= 0 ? 'pos' : 'neg']);

    if (r.is_potm) terms.push(['Player of the match', 'flat', MOTM_BONUS, 'bonus']);
    terms.push(['Multiplier', r.won ? 'winning team' : 'losing team', null, 'mult']);

    // Stored order of operations: the POTM bonus is a second UPDATE on an
    // already-rounded total, so the double rounding has to be reproduced here.
    const base = n2((bat + bowl + field) * factor);
    const total = r.is_potm ? n2(base + MOTM_BONUS * factor) : base;

    const ok = Math.abs(total - Number(r.s_total)) < 0.02
      && Math.abs(n2(bat * factor) - Number(r.s_bat)) < 0.02
      && Math.abs(n2(bowl * factor) - Number(r.s_bowl)) < 0.02
      && Math.abs(n2(field * factor) - Number(r.s_field)) < 0.02;
    if (!ok) mismatches++;

    byPlayer.get(r.player_id).push({
      date: new Date(r.scheduled_start).toISOString().slice(0, 10),
      label: `${r.a_short} v ${r.b_short}`,
      o, mrr, won: r.won, potm: r.is_potm,
      bat: n2(bat * factor), bowl: n2(bowl * factor), field: n2(field * factor),
      rawBat: bat, rawBowl: bowl, rawField: field,
      total, stored: Number(r.s_total), ok, terms, factor,
    });
  }

  // ---------- render ----------
  const css = fs.readFileSync(path.join(__dirname, '..', 'docs', '_report.css'), 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const totalMatches = rows.length;

  const toc = top.map((p, i) =>
    `<li><a href="#p${i + 1}"><span class="n">${i + 1}</span> ${esc(p.full_name)}</a></li>`).join('');

  const sections = top.map((p, i) => {
    const ms = byPlayer.get(p.id);
    const tbody = ms.map((m) => `<tr><td>${m.date}</td><td>${esc(m.label)}</td>` +
      `<td class="num">${f2(m.bat)}</td><td class="num">${f2(m.bowl)}</td><td class="num">${f2(m.field)}</td>` +
      `<td class="num">${m.won ? '×1.1' : '—'}</td><td class="num strong">${f2(m.total)}</td></tr>`).join('');

    const strips = ms.map((m) => {
      const rowsHtml = m.terms.map(([label, work, val, cls]) => {
        const right = cls === 'mult' ? `<span class="mult">×${m.factor.toFixed(1)}</span>`
          : `<span class="${cls}">${f2(val)}</span>`;
        return `<div class="row"><span>${esc(label)}<span class="work">${esc(work)}</span></span>${right}</div>`;
      }).join('');
      const potmWork = m.potm ? ` + ${MOTM_BONUS}` : '';
      const cond = [`${m.date} · ${m.o} ov · match RR ${f2(m.mrr)}`,
        m.won ? '<b class="wl">won</b>' : null,
        m.potm ? '<b class="pm">player of the match</b>' : null].filter(Boolean).join(' · ');
      return `<article class="strip">
        <header class="sh"><h4>${esc(m.label)}</h4><p class="cond">${cond}</p></header>
        <div class="rows">${rowsHtml}</div>
        <div class="total"><span>Match total<span class="work">(${f2(m.rawBat)} + ${f2(m.rawBowl)} + ${f2(m.rawField)}) × ${m.factor.toFixed(1)}${potmWork}</span></span><span>${f2(m.total)}</span></div>
        <p class="rec ${m.ok ? 'okk' : 'bad'}">stored ${f2(m.stored)} · ${m.ok ? 'reconciles' : 'MISMATCH'}</p>
      </article>`;
    }).join('');

    return `<section id="p${i + 1}">
      <h2><span class="n">0${i + 1}</span> ${esc(p.full_name)}</h2>
      <p class="lede">${ms.length} completed matches · career MVP <b>${f2(p.career_mvp)}</b></p>
      <div class="ledger"><table><caption>Match by match</caption>
        <thead><tr><th>Date</th><th>Match</th><th class="num">Bat</th><th class="num">Bowl</th><th class="num">Field</th><th class="num">Mult</th><th class="num">Total</th></tr></thead>
        <tbody>${tbody}</tbody>
        <tfoot><tr><td colspan="6">Career total</td><td class="num strong">${f2(p.career_mvp)}</td></tr></tfoot>
      </table></div>
      <h3>Term by term</h3>
      <div class="calc">${strips}</div>
    </section>`;
  }).join('');

  const html = `<title>CricLive — MVP Audit, Top 3</title>
<style>${css}</style>
<div class="wrap">
  <header class="mast">
    <p class="eyebrow">CricLive · MVP audit</p>
    <h1>Top three, match by match</h1>
    <p class="standfirst">Every match total rebuilt independently from ball-by-ball data using the
      current scoring rules, then reconciled against the figure stored in the database.
      Recalculated after the contribution-point and milestone revision.</p>
    <div class="mast-meta">
      <span class="chip">Players <b>3</b></span>
      <span class="chip">Player-matches audited <b>${totalMatches}</b></span>
      <span class="chip">Mismatches <b style="color:var(--${mismatches ? 'cherry' : 'grass'})">${mismatches}</b></span>
      <span class="chip">Generated <b>${today}</b></span>
    </div>
  </header>
  <nav class="toc" aria-label="Contents"><p>Players</p><ol>${toc}</ol></nav>
  <main>${sections}</main>
  <footer>
    <span>Rules: <code>docs/MVP_SCORING.md</code> · engine: <code>buildMvpPoints()</code></span>
    <span>CricLive</span>
  </footer>
</div>`;

  fs.writeFileSync(OUT, html);
  console.log(`Wrote ${OUT}`);
  console.log(`Player-matches audited: ${totalMatches}, mismatches: ${mismatches}`);
  for (const p of top) console.log(`  ${p.full_name}: ${p.career_mvp} over ${p.matches} matches`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
