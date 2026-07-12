/* eslint-disable no-console */
/**
 * Feature-completeness E2E: exercises every endpoint added in the final audit —
 * profile/permissions, RBAC admin, officials, plan quotas, interruptions+DLS,
 * batch scoring, substitutions, match stats, team stats, in-app notifications.
 *
 * Usage: node scripts/e2e-features.js <email> <password>
 */
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

  // ---- auth extras ----
  const perms = (await api('GET', '/auth/me/permissions')).data;
  if (!perms.length) fail('me/permissions empty');
  ok('GET /auth/me/permissions', `${perms.length} grant group(s)`);
  await api('PATCH', '/auth/me', { phone: '+8801700000000' });
  ok('PATCH /auth/me');
  const forgot = (await api('POST', '/auth/forgot-password', { email })).data;
  if (!forgot.sent) fail('forgot-password');
  ok('POST /auth/forgot-password', 'reset email dispatched');

  // ---- RBAC admin ----
  const catalog = (await api('GET', '/rbac/permissions')).data;
  if (catalog.length < 30) fail(`permission catalog too small: ${catalog.length}`);
  ok('GET /rbac/permissions', `${catalog.length} permissions`);

  const org = (await api('POST', '/orgs', { name: 'Audit Club', slug: `e2e-club-audit-${run}` })).data;
  const roles = (await api('GET', `/orgs/${org.id}/roles`)).data;
  if (roles.filter((r) => r.is_system).length !== 5) fail('expected 5 system roles');
  const statsPerms = catalog.filter((p) => p.action === 'read').slice(0, 4).map((p) => p.id);
  const custom = (await api('POST', `/orgs/${org.id}/roles`, {
    name: 'Analyst', slug: 'analyst', description: 'Read-only analyst', permission_ids: statsPerms,
  })).data;
  await api('PATCH', `/orgs/${org.id}/roles/${custom.id}`, { description: 'Read-only analytics role' });
  ok('custom role create/update', custom.slug);

  // ---- officials ----
  const ump = (await api('POST', `/orgs/${org.id}/officials`, { full_name: 'Billy Bowden Jr', official_type: 'umpire' })).data;
  const ump2 = (await api('POST', `/orgs/${org.id}/officials`, { full_name: 'S. Ravi Jr', official_type: 'umpire' })).data;
  ok('officials created', '2 umpires');

  // ---- teams / players / quota ----
  const A = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Audit Aces', short_name: 'AAC', slug: `a-aces-${run}` })).data;
  const B = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Audit Bolts', short_name: 'ABL', slug: `a-bolts-${run}` })).data;
  const mk = async (n) => (await api('POST', `/orgs/${org.id}/players`, { full_name: n })).data;
  const a1 = await mk('AA One'), a2 = await mk('AA Two'), a3 = await mk('AA Three'), a4 = await mk('AA Four');
  const b1 = await mk('AB One'), b2 = await mk('AB Two'), b3 = await mk('AB Three');

  const formats = (await api('GET', '/formats')).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
  const tour = (await api('POST', `/orgs/${org.id}/tournaments`, {
    name: 'Audit Cup', slug: `audit-cup-${run}`, format_id: t20.id,
    rule_overrides: { overs_per_innings: 2, max_overs_per_bowler: 2, dls: { enabled: true, method: 'DLS', min_overs_per_side: 1 } },
  })).data;
  const quota = await api('POST', `/orgs/${org.id}/tournaments`,
    { name: 'Over Limit', slug: `over-limit-${run}`, format_id: t20.id }, false);
  if (quota.status !== 402 || quota.data.code !== 'PLAN_LIMIT') fail(`expected 402 PLAN_LIMIT, got ${quota.status}`);
  ok('plan quota enforced', `2nd tournament on free plan → 402 PLAN_LIMIT (${quota.data.used}/${quota.data.limit})`);

  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: A.id });
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: B.id });
  const match = (await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tour.id, team_a_id: A.id, team_b_id: B.id, scheduled_start: new Date().toISOString(),
  })).data;

  // ---- squads + substitution + officials assignment ----
  await api('PUT', `/matches/${match.id}/squads`, {
    team_id: A.id,
    players: [
      { player_id: a1.id, batting_order: 1 }, { player_id: a2.id, batting_order: 2 },
      { player_id: a3.id, batting_order: 3 },
      { player_id: a4.id, is_playing_xi: false, is_twelfth: true, can_bat: true, can_bowl: false },
    ],
  });
  await api('PUT', `/matches/${match.id}/squads`, {
    team_id: B.id,
    players: [{ player_id: b1.id, batting_order: 1 }, { player_id: b2.id, batting_order: 2 }, { player_id: b3.id, batting_order: 3 }],
  });
  ok('squads set', 'XI + 12th man (can_bat=true, can_bowl=false)');

  await api('PUT', `/matches/${match.id}/officials`, {
    officials: [{ official_id: ump.id, duty: 'field_umpire_1' }, { official_id: ump2.id, duty: 'field_umpire_2' }],
  });
  const detail = (await api('GET', `/matches/${match.id}`)).data;
  if (detail.officials?.length !== 2) fail('match officials missing');
  ok('match officials assigned', detail.officials.map((o) => `${o.duty}:${o.full_name}`).join(', '));

  const sub = (await api('POST', `/matches/${match.id}/substitutions`, {
    team_id: A.id, out_player_id: a3.id, in_player_id: a4.id, reason: 'impact_player', can_bat: true, can_bowl: true,
  })).data;
  if (!sub.substituted_in_at) fail('substitution failed');
  ok('substitution', 'AA Four in for AA Three (impact_player)');

  // ---- play innings 1 (2 overs): over 1 direct, over 2 via BATCH (offline sync) ----
  const ball = (payload) => api('POST', `/matches/${match.id}/balls`, { client_event_id: uuid(), ...payload });
  await api('POST', `/matches/${match.id}/toss`, { winner_team_id: A.id, decision: 'bat' });
  await api('POST', `/matches/${match.id}/openers`, { striker_id: a1.id, non_striker_id: a2.id, bowler_id: b1.id });
  await ball({ runs_batter: 4, wagon: { angle_deg: 225, distance_pct: 95 } });
  for (const r of [1, 1, 0, 2, 0]) await ball({ runs_batter: r });
  // over 2 as an offline batch with a duplicated event to prove idempotency
  const dup = uuid();
  const batch = (await api('POST', `/matches/${match.id}/balls/batch`, {
    balls: [
      { client_event_id: dup, bowler_id: b2.id, runs_batter: 6 },
      { client_event_id: dup, bowler_id: b2.id, runs_batter: 6 }, // duplicate → deduped
      { client_event_id: uuid(), bowler_id: b2.id, runs_batter: 1 },
      { client_event_id: uuid(), bowler_id: b2.id, runs_batter: 0 },
      { client_event_id: uuid(), bowler_id: b2.id, runs_batter: 0 },
      { client_event_id: uuid(), bowler_id: b2.id, runs_batter: 2 },
      { client_event_id: uuid(), bowler_id: b2.id, runs_batter: 0 },
    ],
  })).data;
  const statuses = batch.results.map((r) => r.status);
  if (!statuses.includes('duplicate')) fail(`batch dedupe failed: ${JSON.stringify(statuses)}`);
  ok('offline batch sync', `${statuses.filter((s) => s === 'applied').length} applied, 1 duplicate deduped`);
  // innings 1 total: 8 + 9 = 17 → target 18

  // ---- innings 2 + rain interruption with DLS revision ----
  await api('POST', `/matches/${match.id}/openers`, { striker_id: b1.id, non_striker_id: b2.id, bowler_id: a1.id });
  await ball({ runs_batter: 1 });
  await ball({ runs_batter: 1 });
  const rain = (await api('POST', `/matches/${match.id}/interruptions`, { reason: 'rain' })).data;
  if (rain.status !== 'rain_delay') fail('interruption did not pause match');
  ok('rain interruption', 'status → rain_delay');
  const blockedBall = await api('POST', `/matches/${match.id}/balls`, { client_event_id: uuid(), runs_batter: 1 }, false);
  if (blockedBall.status !== 400) fail('scoring should be blocked during rain delay');
  ok('scoring blocked during delay');

  const resume = (await api('POST', `/matches/${match.id}/interruptions/resume`, {
    overs_lost: 1, revised_max_overs: 1, revised_target: 7, method: 'DLS',
  })).data;
  if (resume.status !== 'live' || resume.dls?.revised_target !== 7) fail(`resume failed: ${JSON.stringify(resume.dls)}`);
  ok('DLS revision applied', `1 over, revised target 7 (was 18)`);

  // chase: 2+2 = 4... need 7: current 2 + balls: 1(3rd legal),4 → 7 → win
  await ball({ runs_batter: 1 });
  const winBall = await ball({ runs_batter: 4 });
  if (!winBall.data.effects.includes('match_complete')) fail(`chase should finish: ${winBall.data.effects}`);
  await new Promise((r) => setTimeout(r, 1500));
  const final = (await api('GET', `/matches/${match.id}`)).data;
  if (!final.dls_applied) fail('dls_applied flag not set');
  ok('match complete under DLS', final.result_summary);

  // ---- follow the match retroactively? (follows must exist before finalize) → use finalize rerun ----
  await api('POST', '/me/follows', { entity_type: 'tournament', entity_id: tour.id });
  await api('POST', `/matches/${match.id}/finalize`, { player_of_match_id: b1.id });
  await new Promise((r) => setTimeout(r, 800));
  const inbox = (await api('GET', '/me/notifications?unread=true')).data;
  if (!inbox.some((n) => n.event_type === 'match.result')) fail('in-app result notification missing');
  ok('in-app notification delivered', inbox[0].title);

  // ---- stats endpoints ----
  const mstats = (await api('GET', `/matches/${match.id}/stats`)).data;
  if (!mstats.wagon_wheel.length) fail('wagon wheel empty');
  if (!mstats.partnerships.length) fail('partnerships empty');
  if (!mstats.run_rate.length) fail('run rate empty');
  ok('match stats', `wagon=${mstats.wagon_wheel.length} partnerships=${mstats.partnerships.length} rr_points=${mstats.run_rate.length}`);

  const tstats = (await api('GET', `/teams/${B.id}/stats`)).data;
  if (tstats.won !== 1) fail(`team stats wrong: ${JSON.stringify(tstats)}`);
  ok('team stats', `ABL: P${tstats.played} W${tstats.won} form=${tstats.recent_form.map((f) => f.outcome).join('')}`);

  console.log('\nALL FEATURE-AUDIT CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
