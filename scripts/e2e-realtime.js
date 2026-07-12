/* eslint-disable no-console */
/**
 * Advanced E2E: Redis live state, WebSocket push, Super Over, Follow-on.
 *
 * Scenario A (T20 1-over): both sides score 10 → TIE → Super Over child match
 *   → child played → parent result updated. A WebSocket client is subscribed
 *   the whole time and must receive state/ball/status/presence events.
 * Scenario B (2-innings mini-Test): big first-innings lead → follow-on offered
 *   → enforced (innings 3, is_follow_on) → innings victory (no 4th innings).
 *
 * Usage: node scripts/e2e-realtime.js <email> <password>
 */
const { io } = require('socket.io-client');

const BASE = 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
let TOKEN = '';
const uuid = () => crypto.randomUUID();
const run = Date.now().toString(36);
const ok = (label, extra = '') => console.log(`✔ ${label}${extra ? ' — ' + extra : ''}`);
const fail = (msg) => { console.error(`✘ ${msg}`); process.exit(1); };

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
  ok('login');

  // ---------- shared fixtures ----------
  const org = (await api('POST', '/orgs', { name: 'RT Club', slug: `e2e-club-rt-${run}` })).data;
  // This suite needs 2 tournaments — upgrade off the free plan (also tests plan switching)
  const plans = (await api('GET', '/plans')).data;
  await api('POST', `/orgs/${org.id}/subscription`, { plan_id: plans.find((p) => p.slug === 'league').id });
  ok('plan upgraded', 'free → league (trialing)');
  const venue = (await api('POST', `/orgs/${org.id}/venues`, { name: 'RT Ground' })).data;
  const A = (await api('POST', `/orgs/${org.id}/teams`, { name: 'RT Aces', short_name: 'ACE', slug: `aces-${run}` })).data;
  const B = (await api('POST', `/orgs/${org.id}/teams`, { name: 'RT Bolts', short_name: 'BLT', slug: `bolts-${run}` })).data;
  const mk = async (n) => (await api('POST', `/orgs/${org.id}/players`, { full_name: n })).data;
  const a1 = await mk('Ace One'), a2 = await mk('Ace Two'), a3 = await mk('Ace Three');
  const b1 = await mk('Bolt One'), b2 = await mk('Bolt Two'), b3 = await mk('Bolt Three');
  ok('fixtures', 'org, venue, 2 teams, 6 players');

  const formats = (await api('GET', '/formats')).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);

  // ============================================================
  // Scenario A — tie → Super Over, watched over WebSocket
  // ============================================================
  const tourA = (await api('POST', `/orgs/${org.id}/tournaments`, {
    name: 'RT Tie Cup', slug: `rt-tie-${run}`, format_id: t20.id,
    rule_overrides: { overs_per_innings: 1, max_overs_per_bowler: 1 },
  })).data;
  await api('POST', `/tournaments/${tourA.id}/teams`, { team_id: A.id });
  await api('POST', `/tournaments/${tourA.id}/teams`, { team_id: B.id });
  const match = (await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tourA.id, team_a_id: A.id, team_b_id: B.id, venue_id: venue.id,
    scheduled_start: new Date().toISOString(),
  })).data;

  // WebSocket viewer joins before play begins
  const events = { state: 0, ball: 0, status: 0, presence: 0, recent_balls: 0, correction: 0 };
  const socket = io('http://localhost:3001/live', { transports: ['websocket'] });
  // Listeners must be attached BEFORE join — the snapshot events arrive with the ack
  for (const ev of Object.keys(events)) socket.on(ev, () => events[ev]++);
  await new Promise((resolve, reject) => {
    socket.on('connect', () => {
      socket.emit('join', { room: `match:${match.id}` }, (ack) => (ack?.joined ? resolve() : reject(new Error('join failed'))));
    });
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 8000);
  });
  ok('WebSocket connected + joined room');

  const ball = (id, payload) => api('POST', `/matches/${id}/balls`, { client_event_id: uuid(), ...payload });

  // Innings 1: ACE bat — 4,1,1,0,0,4 = 10
  await api('POST', `/matches/${match.id}/toss`, { winner_team_id: A.id, decision: 'bat' });
  await api('POST', `/matches/${match.id}/openers`, { striker_id: a1.id, non_striker_id: a2.id, bowler_id: b1.id });
  for (const r of [4, 1, 1, 0, 0, 4]) await ball(match.id, { runs_batter: r });

  // Innings 2: BLT chase 11 — 4,4,2,0,0,0 = 10 → TIE
  await api('POST', `/matches/${match.id}/openers`, { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id });
  for (const r of [4, 4, 2, 0, 0, 0]) await ball(match.id, { runs_batter: r });

  let st = (await api('GET', `/matches/${match.id}/state`)).data;
  if (st.status !== 'completed') fail(`expected completed, got ${st.status}`);
  const parent = (await api('GET', `/matches/${match.id}`)).data;
  if (parent.result_type !== 'tie') fail(`expected tie, got ${parent.result_type} (${parent.result_summary})`);
  ok('Scenario A: match TIED', parent.result_summary);
  ok('state served from', st.source);

  // Super Over
  const so = (await api('POST', `/matches/${match.id}/super-over`)).data;
  ok('super over created', `${so.stage_label}, parent=${so.parent_match_id === match.id ? 'linked' : 'MISSING'}`);

  // Child: BLT bat first — 6,1 wait 2 wickets allowed... play simple: 6,6,6,W,W? Keep quick:
  await api('POST', `/matches/${so.id}/toss`, { winner_team_id: B.id, decision: 'bat' });
  await api('POST', `/matches/${so.id}/openers`, { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id });
  for (const r of [6, 4, 1, 1, 0, 2]) await ball(so.id, { runs_batter: r }); // BLT 14

  await api('POST', `/matches/${so.id}/openers`, { striker_id: a1.id, non_striker_id: a2.id, bowler_id: b1.id });
  await ball(so.id, { runs_batter: 6 });
  await ball(so.id, { runs_batter: 4 });
  await ball(so.id, { runs_batter: 1 });
  let last = await ball(so.id, { wicket: { type: 'bowled' } });
  await api('POST', `/matches/${so.id}/new-batter`, { player_id: a3.id });
  last = await ball(so.id, { wicket: { type: 'bowled' } }); // 2nd wicket = all out at 11 → BLT win by 3
  if (!last.data.effects.includes('match_complete')) fail(`super over should be complete: ${last.data.effects}`);

  await new Promise((r) => setTimeout(r, 1200));
  const parentAfter = (await api('GET', `/matches/${match.id}`)).data;
  if (parentAfter.result_type !== 'win' || !parentAfter.winner_team_id) fail('parent result not updated from super over');
  if (!parentAfter.child_matches?.length) fail('child_matches missing on parent');
  ok('parent aggregated child result', `${parentAfter.result_summary} | children: ${parentAfter.child_matches.length}`);

  // WS + Redis extras
  const recent = (await api('GET', `/matches/${match.id}/balls/recent`)).data;
  const presence = (await api('GET', `/matches/${match.id}/presence`)).data;
  ok('recent-balls stream', `${recent.length} events cached`);
  ok('presence', `viewers=${presence.viewers}`);
  if (events.state < 1 || events.ball < 10 || events.status < 3) {
    fail(`WS events too few: ${JSON.stringify(events)}`);
  }
  ok('WebSocket push received', JSON.stringify(events));
  socket.close();

  // ============================================================
  // Scenario B — mini-Test: follow-on → innings victory
  // ============================================================
  const mini = (await api('POST', `/orgs/${org.id}/formats`, {
    name: 'Mini Test', slug: `mini-test-${run}`,
    rules: {
      innings_per_side: 2, overs_per_innings: 1, balls_per_over: 6, players_per_side: 11,
      max_overs_per_bowler: null, wickets_to_fall: 10,
      powerplays: [], super_over: { enabled: false }, dls: { enabled: false },
      follow_on: { enabled: true, deficit: 5 }, declaration_allowed: true,
      no_ball: { runs: 1, free_hit: false }, wide: { runs: 1 },
      twelfth_man: { allowed: true }, duration_days: 1,
    },
  })).data;
  const tourB = (await api('POST', `/orgs/${org.id}/tournaments`, {
    name: 'RT Test Series', slug: `rt-test-${run}`, format_id: mini.id,
  })).data;
  await api('POST', `/tournaments/${tourB.id}/teams`, { team_id: A.id });
  await api('POST', `/tournaments/${tourB.id}/teams`, { team_id: B.id });
  const test = (await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tourB.id, team_a_id: A.id, team_b_id: B.id, venue_id: venue.id,
    scheduled_start: new Date().toISOString(),
  })).data;

  // Innings 1: ACE 12 (4,4,4 then over ends after 6 balls)
  await api('POST', `/matches/${test.id}/toss`, { winner_team_id: A.id, decision: 'bat' });
  await api('POST', `/matches/${test.id}/openers`, { striker_id: a1.id, non_striker_id: a2.id, bowler_id: b1.id });
  for (const r of [4, 4, 4, 0, 0, 0]) await ball(test.id, { runs_batter: r });

  // Innings 2: BLT 2 → trail by 10 ≥ deficit 5 → follow-on decision pending
  await api('POST', `/matches/${test.id}/openers`, { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id });
  for (const r of [1, 1, 0, 0, 0, 0]) await ball(test.id, { runs_batter: r });

  st = (await api('GET', `/matches/${test.id}/state`)).data;
  if (!st.follow_on_available) fail(`follow-on not offered: ${JSON.stringify(st.follow_on_available)}`);
  ok('follow-on offered', `lead=${st.follow_on_available.lead} (deficit ${st.follow_on_available.deficit})`);

  // Openers must be blocked while the decision is pending
  const blocked = await api('POST', `/matches/${test.id}/openers`,
    { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id }, false);
  if (blocked.status !== 400) fail('openers should be blocked during follow-on decision');
  ok('openers blocked until follow-on decided');

  const fo = (await api('POST', `/matches/${test.id}/follow-on`, { enforce: true })).data;
  ok('follow-on ENFORCED', `innings ${fo.state.innings_seq} — BLT bat again`);

  // Innings 3 (follow-on): BLT 3 → aggregate 5 < ACE 12 → innings victory, no 4th innings
  await api('POST', `/matches/${test.id}/openers`, { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id });
  for (const r of [1, 1, 1, 0, 0, 0]) await ball(test.id, { runs_batter: r });

  await new Promise((r) => setTimeout(r, 1200));
  const testFinal = (await api('GET', `/matches/${test.id}`)).data;
  if (testFinal.status !== 'completed') fail(`mini-Test should be complete, got ${testFinal.status}`);
  if (testFinal.win_margin?.by !== 'innings') fail(`expected innings victory, got ${JSON.stringify(testFinal.win_margin)}`);
  const inn3 = testFinal.innings.find((i) => i.seq === 3);
  if (!inn3?.is_follow_on) fail('innings 3 not flagged is_follow_on');
  ok('Scenario B: innings victory', testFinal.result_summary);
  ok('innings sequence dynamic', testFinal.innings.map((i) => `#${i.seq}${i.is_follow_on ? '(FO)' : ''}:${i.batting_team} ${i.total_runs}`).join(' | '));

  console.log('\nALL REALTIME E2E CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
