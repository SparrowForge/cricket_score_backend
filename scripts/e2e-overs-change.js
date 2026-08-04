/* eslint-disable no-console */
/**
 * E2E: changing "overs per innings" mid-match.
 *
 * Covers the reported bug (reduce 10 → 2 during innings 1, keep scoring past
 * over 2) plus the two rules around it: the new length may never sit behind the
 * balls already bowled, and setting it to exactly what's been bowled closes the
 * innings on the spot.
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

(async () => {
  if (process.env.E2E_TOKEN) {
    TOKEN = process.env.E2E_TOKEN;
  } else if (email && password) {
    TOKEN = (await api('POST', '/auth/login', { email, password })).data.access_token;
  } else {
    fail('usage: node scripts/e2e-overs-change.js <email> <password>  (or set E2E_TOKEN)');
  }

  // ---- fixture: a 10-over tournament match ----
  const org = (await api('POST', '/orgs', { name: 'Overs Club', slug: `e2e-club-overs-${run}` })).data;
  const A = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Ov Alphas', short_name: 'OAL', slug: `oal-${run}` })).data;
  const B = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Ov Bravos', short_name: 'OBR', slug: `obr-${run}` })).data;
  const mk = async (n) => (await api('POST', `/orgs/${org.id}/players`, { full_name: n })).data;
  const a1 = await mk('Oa One'), a2 = await mk('Oa Two');
  const b1 = await mk('Ob One'), b2 = await mk('Ob Two');

  const formats = (await api('GET', '/formats')).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
  const tour = (await api('POST', `/orgs/${org.id}/tournaments`, {
    name: 'Overs Cup', slug: `overs-cup-${run}`, format_id: t20.id,
    rule_overrides: { overs_per_innings: 10, max_overs_per_bowler: 10 },
  })).data;
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: A.id });
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: B.id });
  const match = (await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tour.id, team_a_id: A.id, team_b_id: B.id, scheduled_start: new Date().toISOString(),
  })).data;

  const ball = (p) => api('POST', `/matches/${match.id}/balls`, { client_event_id: uuid(), ...p });
  const state = async () => (await api('GET', `/matches/${match.id}/state`)).data;
  const settings = (body, expectOk = true) =>
    api('PATCH', `/matches/${match.id}/settings`, body, expectOk);
  const inningsRows = async () => (await api('GET', `/matches/${match.id}`)).data.innings;

  // ================= INNINGS 1 =================
  await api('POST', `/matches/${match.id}/toss`, { winner_team_id: A.id, decision: 'bat' });
  await api('POST', `/matches/${match.id}/openers`, { striker_id: a1.id, non_striker_id: a2.id, bowler_id: b1.id });

  for (let i = 0; i < 6; i++) await ball({ runs_batter: 2 });            // over 1
  for (let i = 0; i < 3; i++) await ball({ runs_batter: 2, bowler_id: b2.id }); // 1.3
  let st = await state();
  if (st.engine.legalBalls !== 9) fail(`expected 9 legal balls, got ${st.engine.legalBalls}`);
  if (st.engine.maxOvers !== 10) fail(`expected maxOvers 10, got ${st.engine.maxOvers}`);
  ok('innings 1 at 1.3 overs', `${st.summary.score} (${st.summary.overs}), limit ${st.engine.maxOvers}`);

  // ---- cannot reduce behind the balls already bowled ----
  const tooLow = await settings({ overs_per_innings: 1 }, false);
  if (tooLow.status !== 400) fail(`expected 400 reducing to 1 over at 1.3, got ${tooLow.status}`);
  if (!/1\.3 overs have already been bowled/.test(tooLow.data.message ?? '')) {
    fail(`unexpected rejection message: ${JSON.stringify(tooLow.data)}`);
  }
  ok('reducing below balls bowled rejected', tooLow.data.message);

  // ---- the reported bug: 10 → 2 mid-innings must reach the live innings ----
  const cut = await settings({ overs_per_innings: 2 });
  if (cut.data.innings_closed) fail('innings closed early — 1.3 of 2 overs bowled');
  st = await state();
  if (st.engine.maxOvers !== 2) fail(`engine still on the old limit: maxOvers ${st.engine.maxOvers}`);
  let rows = await inningsRows();
  if (Number(rows[0].max_overs) !== 2) fail(`innings row still on the old limit: ${rows[0].max_overs}`);
  ok('10 → 2 applied to the live innings', 'engine + innings row both at 2');

  // ---- and the innings must now actually END at 2 overs ----
  let r;
  for (let i = 0; i < 3; i++) r = await ball({ runs_batter: 2 });
  if (!r.data.effects.includes('innings_complete')) {
    fail(`innings did not end at 2.0 overs — effects: ${JSON.stringify(r.data.effects)}`);
  }
  st = await state();
  if (st.status !== 'innings_break' || st.innings_seq !== 2) {
    fail(`expected innings_break / seq 2, got ${st.status} / ${st.innings_seq}`);
  }
  ok('innings 1 ended at 2.0 overs', '24/0 → innings break');

  rows = await inningsRows();
  if (Number(rows[1].max_overs) !== 2) fail(`innings 2 created with the old limit: ${rows[1].max_overs}`);
  ok('innings 2 inherits the new length', '2 overs');

  // ================= INNINGS 2 =================
  await api('POST', `/matches/${match.id}/openers`, { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id });
  for (let i = 0; i < 6; i++) await ball({ runs_batter: 1 });
  st = await state();
  ok('innings 2 at 1.0 over', `${st.summary.score}, chasing ${st.summary.target}`);

  // ---- the innings length is editable in the 2nd innings too ----
  const raise = await settings({ overs_per_innings: 3 });
  if (raise.data.innings_closed) fail('raising the limit must not close the innings');
  st = await state();
  if (st.engine.maxOvers !== 3) fail(`2nd-innings edit not applied: maxOvers ${st.engine.maxOvers}`);
  ok('2 → 3 applied during the 2nd innings', 'engine at 3');

  for (let i = 0; i < 6; i++) r = await ball({ runs_batter: 1, ...(i === 0 ? { bowler_id: a2.id } : {}) });
  if (r.data.effects.includes('innings_complete')) fail('innings ended at 2.0 — the raise to 3 did not take');
  ok('play continues past the old 2-over limit', '12/0 after 2.0');

  const behind = await settings({ overs_per_innings: 1 }, false);
  if (behind.status !== 400) fail(`expected 400 reducing to 1 over at 2.0, got ${behind.status}`);
  ok('2nd-innings reduction below balls bowled rejected', behind.data.message);

  // ---- setting it to exactly the overs bowled ends the innings (and the chase) ----
  const closeNow = await settings({ overs_per_innings: 2 });
  if (!closeNow.data.innings_closed) fail('setting the limit to the overs already bowled did not close the innings');
  st = await state();
  if (st.status !== 'completed') fail(`expected completed match, got ${st.status}`);
  if (!/won by 12 runs/.test(st.result_summary ?? '')) fail(`unexpected result: ${st.result_summary}`);
  ok('limit == overs bowled closed the chase', st.result_summary);

  const final = await inningsRows();
  if (final[1].status !== 'completed') fail(`innings 2 left ${final[1].status}`);
  ok('innings rows finalised', final.map((i) => `${i.seq}:${i.status}`).join(' '));

  // ---- and a finished match stays frozen ----
  const frozen = await settings({ overs_per_innings: 5 }, false);
  if (frozen.status !== 400) fail(`settings should be rejected on a completed match, got ${frozen.status}`);
  ok('completed match rejects further settings edits');

  console.log('\nALL OVERS-CHANGE CHECKS PASSED');
  console.log(`(cleanup: node scripts/cleanup-e2e.js  — org ${org.slug})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
