/* eslint-disable no-console */
/**
 * E2E: innings reopen (undo declare) + auto ball-by-ball commentary.
 * Usage: node scripts/e2e-reopen.js <email> <password>
 */
const BASE = 'http://localhost:3001/api/v1';
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
  TOKEN = (await api('POST', '/auth/login', { email, password })).data.access_token;
  const org = (await api('POST', '/orgs', { name: 'Reopen Club', slug: `e2e-club-reopen-${run}` })).data;
  const A = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Re Alphas', short_name: 'RAL', slug: `ral-${run}` })).data;
  const B = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Re Bravos', short_name: 'RBR', slug: `rbr-${run}` })).data;
  const mk = async (n) => (await api('POST', `/orgs/${org.id}/players`, { full_name: n })).data;
  const a1 = await mk('Ra One'), a2 = await mk('Ra Two');
  const b1 = await mk('Rb One'), b2 = await mk('Rb Two');

  const formats = (await api('GET', '/formats')).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
  const tour = (await api('POST', `/orgs/${org.id}/tournaments`, {
    name: 'Reopen Cup', slug: `reopen-cup-${run}`, format_id: t20.id,
    rule_overrides: { overs_per_innings: 2, max_overs_per_bowler: 2, declaration_allowed: true },
  })).data;
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: A.id });
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: B.id });
  const match = (await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tour.id, team_a_id: A.id, team_b_id: B.id, scheduled_start: new Date().toISOString(),
  })).data;

  const ball = (p) => api(`POST`, `/matches/${match.id}/balls`, { client_event_id: uuid(), ...p });
  await api('POST', `/matches/${match.id}/toss`, { winner_team_id: A.id, decision: 'bat' });
  await api('POST', `/matches/${match.id}/openers`, { striker_id: a1.id, non_striker_id: a2.id, bowler_id: b1.id });
  await ball({ runs_batter: 4 });
  await ball({ runs_batter: 6 });
  await ball({ runs_batter: 1 });
  ok('3 balls scored', '11/0');

  // ---- auto commentary ----
  const comm = (await api('GET', `/matches/${match.id}/commentary`)).data;
  if (comm.length < 3) fail(`expected 3 auto commentary entries, got ${comm.length}`);
  if (!comm.some((c) => c.source === 'auto' && c.body.includes('SIX'))) fail('SIX commentary missing');
  ok('auto ball-by-ball commentary', `"${comm[0].body}"`);

  // ---- accidental declare ----
  await api('POST', `/matches/${match.id}/innings/close`, { reason: 'declared' });
  let st = (await api('GET', `/matches/${match.id}/state`)).data;
  if (st.status !== 'innings_break' || st.innings_seq !== 2) fail(`expected innings_break seq2, got ${st.status}/${st.innings_seq}`);
  ok('innings declared (by mistake)', 'innings 2 pending');

  // ---- reopen ----
  const reopened = (await api('POST', `/matches/${match.id}/innings/reopen`)).data;
  if (reopened.reopened_innings !== 1) fail('wrong innings reopened');
  st = (await api('GET', `/matches/${match.id}/state`)).data;
  if (st.status !== 'live' || st.innings_seq !== 1) fail(`expected live innings1, got ${st.status}/${st.innings_seq}`);
  if (st.summary.score !== '11/0') fail(`state not rebuilt: ${st.summary.score}`);
  ok('innings REOPENED', `back live at ${st.summary.score} (${st.summary.overs})`);

  // ---- innings table sanity: only 1 innings, in_progress ----
  const detail = (await api('GET', `/matches/${match.id}`)).data;
  if (detail.innings.length !== 1 || detail.innings[0].status !== 'in_progress') {
    fail(`innings table wrong: ${JSON.stringify(detail.innings.map((i) => [i.seq, i.status]))}`);
  }
  ok('innings table restored', '1 innings, in_progress');

  // ---- keep scoring after reopen ----
  const r = await ball({ runs_batter: 2 });
  if (!r.data.state || r.data.state.summary.score !== '13/0') fail(`scoring after reopen broken: ${r.data.state?.summary?.score}`);
  ok('scoring continues after reopen', r.data.state.summary.score);

  // ---- reopen when innings open must fail ----
  const bad = await api('POST', `/matches/${match.id}/innings/reopen`, undefined, false);
  if (bad.status !== 400) fail('reopen should be rejected while innings is open');
  ok('reopen correctly rejected while innings open');

  // ---- undo removes its auto commentary ----
  await api('DELETE', `/matches/${match.id}/balls/last`);
  const comm2 = (await api('GET', `/matches/${match.id}/commentary`)).data;
  if (comm2.some((c) => c.body.includes('2 runs. 13/0'))) fail('undone ball commentary not removed');
  ok('undo removed its commentary line');

  console.log('\nALL REOPEN/COMMENTARY CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
