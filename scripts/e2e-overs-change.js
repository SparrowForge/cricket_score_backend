/* eslint-disable no-console */
/**
 * E2E: changing "overs per innings" mid-match.
 *
 * Covers the reported bug (reduce 10 → 2 during innings 1, keep scoring past
 * over 2) plus the three rules around it:
 *   - the new length may never sit behind the balls already bowled;
 *   - no innings may be allocated more overs than one that has already
 *     finished (so the chase can't be handed overs the first innings never had);
 *   - setting it to exactly what has been bowled closes the innings on the spot.
 *
 * Usage: node scripts/e2e-overs-change.js <email> <password>
 *    or: E2E_TOKEN=<access_token> node scripts/e2e-overs-change.js
 */
const BASE = process.env.E2E_BASE || 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
let TOKEN = '';
const uuid = () => crypto.randomUUID();
const run = Date.now().toString(36);
const ok = (l, e = '') => console.log(`✔ ${l}${e ? ' — ' + e : ''}`);
const fail = (m) => { console.error(`✘ ${m}`); process.exit(1); };

async function api(method, path, body, expectOk = true) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expectOk && !res.ok) fail(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return { status: res.status, data };
}

/** A fresh 10-over tournament match, tossed, with openers set. */
async function fixture(org, tour, tag) {
  const A = (await api('POST', `/orgs/${org.id}/teams`, { name: `Ov Alphas ${tag}`, short_name: 'OAL', slug: `oal-${tag}-${run}` })).data;
  const B = (await api('POST', `/orgs/${org.id}/teams`, { name: `Ov Bravos ${tag}`, short_name: 'OBR', slug: `obr-${tag}-${run}` })).data;
  const mk = async (n) => (await api('POST', `/orgs/${org.id}/players`, { full_name: n })).data;
  const players = { a1: await mk(`Oa One ${tag}`), a2: await mk(`Oa Two ${tag}`), b1: await mk(`Ob One ${tag}`), b2: await mk(`Ob Two ${tag}`) };
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: A.id });
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: B.id });
  const match = (await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tour.id, team_a_id: A.id, team_b_id: B.id, scheduled_start: new Date().toISOString(),
  })).data;
  await api('POST', `/matches/${match.id}/toss`, { winner_team_id: A.id, decision: 'bat' });
  await api('POST', `/matches/${match.id}/openers`, { striker_id: players.a1.id, non_striker_id: players.a2.id, bowler_id: players.b1.id });
  return {
    match, A, B, ...players,
    ball: (p) => api('POST', `/matches/${match.id}/balls`, { client_event_id: uuid(), ...p }),
    state: async () => (await api('GET', `/matches/${match.id}/state`)).data,
    settings: (body, expectOk = true) => api('PATCH', `/matches/${match.id}/settings`, body, expectOk),
    inningsRows: async () => (await api('GET', `/matches/${match.id}`)).data.innings,
  };
}

(async () => {
  if (process.env.E2E_TOKEN) {
    TOKEN = process.env.E2E_TOKEN;
  } else if (email && password) {
    TOKEN = (await api('POST', '/auth/login', { email, password })).data.access_token;
  } else {
    fail('usage: node scripts/e2e-overs-change.js <email> <password>  (or set E2E_TOKEN)');
  }

  const org = (await api('POST', '/orgs', { name: 'Overs Club', slug: `e2e-club-overs-${run}` })).data;
  const formats = (await api('GET', '/formats')).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
  const tour = (await api('POST', `/orgs/${org.id}/tournaments`, {
    name: 'Overs Cup', slug: `overs-cup-${run}`, format_id: t20.id,
    rule_overrides: { overs_per_innings: 10, max_overs_per_bowler: 10 },
  })).data;

  // =========================================================================
  // MATCH 1 — the reported scenario, then the chase
  // =========================================================================
  const m = await fixture(org, tour, 'a');
  let r;
  let st;

  for (let i = 0; i < 6; i++) await m.ball({ runs_batter: 2 });                     // over 1
  for (let i = 0; i < 3; i++) await m.ball({ runs_batter: 2, bowler_id: m.b2.id }); // 1.3
  st = await m.state();
  if (st.engine.legalBalls !== 9) fail(`expected 9 legal balls, got ${st.engine.legalBalls}`);
  if (st.engine.maxOvers !== 10) fail(`expected maxOvers 10, got ${st.engine.maxOvers}`);
  ok('innings 1 at 1.3 overs', `${st.summary.score} (${st.summary.overs}), limit ${st.engine.maxOvers}`);

  // ---- cannot reduce behind the balls already bowled ----
  const tooLow = await m.settings({ overs_per_innings: 1 }, false);
  if (tooLow.status !== 400) fail(`expected 400 reducing to 1 over at 1.3, got ${tooLow.status}`);
  if (!/1\.3 overs have already been bowled/.test(tooLow.data.message ?? '')) {
    fail(`unexpected rejection message: ${JSON.stringify(tooLow.data)}`);
  }
  ok('reducing below balls bowled rejected', tooLow.data.message);

  // ---- innings 1 has no ceiling — nothing has finished yet ----
  const raiseFirst = await m.settings({ overs_per_innings: 12 });
  if (raiseFirst.data.rules_snapshot.overs_per_innings !== 12) fail('raising the first innings should be allowed');
  ok('first innings can still be raised', 'no completed innings to cap against');

  // ---- the reported bug: 10 → 2 mid-innings must reach the live innings ----
  const cut = await m.settings({ overs_per_innings: 2 });
  if (cut.data.innings_closed) fail('innings closed early — 1.3 of 2 overs bowled');
  st = await m.state();
  if (st.engine.maxOvers !== 2) fail(`engine still on the old limit: maxOvers ${st.engine.maxOvers}`);
  let rows = await m.inningsRows();
  if (Number(rows[0].max_overs) !== 2) fail(`innings row still on the old limit: ${rows[0].max_overs}`);
  ok('10 → 2 applied to the live innings', 'engine + innings row both at 2');

  // ---- and the innings must now actually END at 2 overs ----
  for (let i = 0; i < 3; i++) r = await m.ball({ runs_batter: 2 });
  if (!r.data.effects.includes('innings_complete')) {
    fail(`innings did not end at 2.0 overs — effects: ${JSON.stringify(r.data.effects)}`);
  }
  st = await m.state();
  if (st.status !== 'innings_break' || st.innings_seq !== 2) {
    fail(`expected innings_break / seq 2, got ${st.status} / ${st.innings_seq}`);
  }
  ok('innings 1 ended at 2.0 overs', '24/0 → innings break');

  rows = await m.inningsRows();
  if (Number(rows[1].max_overs) !== 2) fail(`innings 2 created with the old limit: ${rows[1].max_overs}`);
  ok('innings 2 inherits the new length', '2 overs');

  // ---- the ceiling exists the moment an innings is in the books ----
  const capAtBreak = await m.settings({ overs_per_innings: 5 }, false);
  if (capAtBreak.status !== 400) fail(`expected 400 raising to 5 at the innings break, got ${capAtBreak.status}`);
  if (!/only allocated 2 overs/.test(capAtBreak.data.message ?? '')) {
    fail(`unexpected cap message: ${JSON.stringify(capAtBreak.data)}`);
  }
  ok('raising above the completed innings rejected at the break', capAtBreak.data.message);

  // ================= INNINGS 2 =================
  await api('POST', `/matches/${m.match.id}/openers`, { striker_id: m.b1.id, non_striker_id: m.b2.id, bowler_id: m.a1.id });
  for (let i = 0; i < 6; i++) await m.ball({ runs_batter: 1 });
  st = await m.state();
  ok('innings 2 at 1.0 over', `${st.summary.score}, chasing ${st.summary.target}`);

  // ---- the chase cannot be handed overs the first innings never had ----
  const chaseTooHigh = await m.settings({ overs_per_innings: 3 }, false);
  if (chaseTooHigh.status !== 400) fail(`expected 400 raising the chase to 3, got ${chaseTooHigh.status}`);
  if (!/cannot get more/.test(chaseTooHigh.data.message ?? '')) {
    fail(`unexpected cap message: ${JSON.stringify(chaseTooHigh.data)}`);
  }
  ok('raising the chase above innings 1 rejected', chaseTooHigh.data.message);

  // ---- the ceiling is inclusive: re-setting it to 2 is a legal no-op ----
  const atCap = await m.settings({ overs_per_innings: 2 });
  if (atCap.data.innings_closed) fail('re-setting the chase to 2 must not close it at 1.0 over');
  st = await m.state();
  if (st.engine.maxOvers !== 2) fail(`chase limit changed unexpectedly: ${st.engine.maxOvers}`);
  ok('setting the chase to exactly the ceiling accepted', 'still 2, innings open');

  for (let i = 0; i < 3; i++) await m.ball({ runs_batter: 1, ...(i === 0 ? { bowler_id: m.a2.id } : {}) });
  const chaseTooLow = await m.settings({ overs_per_innings: 1 }, false);
  if (chaseTooLow.status !== 400) fail(`expected 400 reducing the chase to 1 at 1.3, got ${chaseTooLow.status}`);
  ok('2nd-innings reduction below balls bowled rejected', chaseTooLow.data.message);

  // ---- chase runs out of overs on the ball path ----
  for (let i = 0; i < 3; i++) r = await m.ball({ runs_batter: 1 });
  if (!r.data.effects.includes('match_complete')) {
    fail(`chase did not end at 2.0 overs — effects: ${JSON.stringify(r.data.effects)}`);
  }
  st = await m.state();
  if (st.status !== 'completed') fail(`expected completed match, got ${st.status}`);
  if (!/won by 12 runs/.test(st.result_summary ?? '')) fail(`unexpected result: ${st.result_summary}`);
  ok('chase ended at its 2 overs', st.result_summary);

  const frozen = await m.settings({ overs_per_innings: 2 }, false);
  if (frozen.status !== 400) fail(`settings should be rejected on a completed match, got ${frozen.status}`);
  ok('completed match rejects further settings edits');

  // =========================================================================
  // MATCH 2 — limit set to exactly the overs bowled closes the innings
  // =========================================================================
  const n = await fixture(org, tour, 'b');
  for (let i = 0; i < 6; i++) await n.ball({ runs_batter: 3 });
  let nst = await n.state();
  if (nst.engine.legalBalls !== 6) fail(`expected 6 legal balls, got ${nst.engine.legalBalls}`);

  const closeNow = await n.settings({ overs_per_innings: 1 });
  if (!closeNow.data.innings_closed) fail('setting the limit to the overs already bowled did not close the innings');
  nst = await n.state();
  if (nst.status !== 'innings_break' || nst.innings_seq !== 2) {
    fail(`expected innings_break / seq 2, got ${nst.status} / ${nst.innings_seq}`);
  }
  ok('limit == overs bowled closed innings 1', '18/0 (1.0) → innings break');

  const nrows = await n.inningsRows();
  if (nrows[0].status !== 'completed') fail(`innings 1 left ${nrows[0].status}`);
  if (Number(nrows[1].max_overs) !== 1) fail(`innings 2 allocated ${nrows[1].max_overs}, expected 1`);
  ok('innings 2 opened at the new 1-over length', nrows.map((i) => `${i.seq}:${i.status}:${i.max_overs}`).join(' '));

  console.log('\nALL OVERS-CHANGE CHECKS PASSED');
  console.log(`(cleanup: node scripts/cleanup-e2e.js  — org ${org.slug})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
