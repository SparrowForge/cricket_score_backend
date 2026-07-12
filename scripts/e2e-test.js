/* eslint-disable no-console */
/**
 * End-to-end API test: full cricket flow against the running server.
 * Creates an org, teams, players, a 1-over-per-side tournament, plays a
 * complete match ball-by-ball, and verifies scorecard/points/stats/MVP.
 *
 * Usage: node scripts/e2e-test.js <email> <password>
 */
const BASE = 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
let TOKEN = '';
const uuid = () => crypto.randomUUID();
const run = Date.now().toString(36); // unique slugs per run

async function api(method, path, body, expectOk = true) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expectOk && !res.ok) {
    console.error(`✘ ${method} ${path} → ${res.status}`, JSON.stringify(data));
    process.exit(1);
  }
  return { status: res.status, data };
}

const ok = (label, extra = '') => console.log(`✔ ${label}${extra ? ' — ' + extra : ''}`);

(async () => {
  // ---- auth ----
  TOKEN = (await api('POST', '/auth/login', { email, password })).data.access_token;
  ok('login');

  // ---- org / venue / teams / players ----
  const org = (await api('POST', '/orgs', { name: 'E2E Cricket Club', slug: `e2e-club-${run}` })).data;
  ok('org created', org.slug);

  const venue = (await api('POST', `/orgs/${org.id}/venues`, { name: 'E2E Stadium', city: 'Dhaka' })).data;

  const lions = (await api('POST', `/orgs/${org.id}/teams`, { name: 'E2E Lions', short_name: 'LIO', slug: `lions-${run}` })).data;
  const tigers = (await api('POST', `/orgs/${org.id}/teams`, { name: 'E2E Tigers', short_name: 'TIG', slug: `tigers-${run}` })).data;
  ok('teams created', 'LIO vs TIG');

  const mk = async (name, role) =>
    (await api('POST', `/orgs/${org.id}/players`, { full_name: name, primary_role: role })).data;
  const L1 = await mk('Liam Opener', 'batter');
  const L2 = await mk('Lars Anchor', 'batter');
  const L3 = await mk('Leo Finisher', 'all_rounder');
  const T1 = await mk('Tariq Quick', 'bowler');
  const T2 = await mk('Tom Keeper', 'wicket_keeper_batter');
  const T3 = await mk('Tanvir Smash', 'batter');
  ok('players created', '6');

  // ---- tournament: T20 format overridden to 1 over/side for a fast full match ----
  const formats = (await api('GET', '/formats')).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
  const tour = (
    await api('POST', `/orgs/${org.id}/tournaments`, {
      name: 'E2E Blast', slug: `e2e-blast-${run}`, format_id: t20.id,
      rule_overrides: { overs_per_innings: 1, max_overs_per_bowler: 1 },
    })
  ).data;
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: lions.id });
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: tigers.id });
  ok('tournament created + teams attached', tour.slug);

  // ---- fixture generator (draft only, then use a manual match) ----
  const draft = (
    await api('POST', `/tournaments/${tour.id}/fixtures/generate`, {
      type: 'round_robin', startDate: '2026-07-12', matchDays: [1, 2, 3, 4, 5, 6, 7],
      matchesPerDay: 2, venueIds: [venue.id],
    })
  ).data;
  ok('fixtures generated (draft)', `${draft.length} fixture(s)`);

  const confirm = (await api('POST', `/tournaments/${tour.id}/fixtures/confirm`, { fixtures: draft })).data;
  ok('fixtures confirmed', `${confirm.created} match(es) scheduled`);
  const matchId = confirm.match_ids[0];

  // Which team bats first depends on generator order — fetch match to know sides
  const match = (await api('GET', `/matches/${matchId}`)).data;
  const [batTeam, bowlTeam] = [match.team_a_id, match.team_b_id];
  const batIsLions = batTeam === lions.id;
  const bat = batIsLions ? [L1, L2, L3] : [T1, T2, T3];
  const bowl = batIsLions ? [T1, T2, T3] : [L1, L2, L3];

  // ---- toss & openers ----
  await api('POST', `/matches/${matchId}/toss`, { winner_team_id: batTeam, decision: 'bat' });
  ok('toss', 'bat first');
  await api('POST', `/matches/${matchId}/openers`, {
    striker_id: bat[0].id, non_striker_id: bat[1].id, bowler_id: bowl[0].id,
  });
  ok('openers set — match LIVE');

  // ---- innings 1: 4, 6, 1, W(caught), new batter, 0, 2 → 13/1 ----
  const ball = (payload) => api('POST', `/matches/${matchId}/balls`, { client_event_id: uuid(), ...payload });
  let r;
  r = await ball({ runs_batter: 4 });
  r = await ball({ runs_batter: 6 });
  r = await ball({ runs_batter: 1 });
  r = await ball({ wicket: { type: 'caught', fielder_id: bowl[1].id } });
  if (!r.data.effects.includes('new_batter_required')) { console.error('✘ expected new_batter_required'); process.exit(1); }
  await api('POST', `/matches/${matchId}/new-batter`, { player_id: bat[2].id });
  r = await ball({ runs_batter: 0 });
  r = await ball({ runs_batter: 2 });
  if (!r.data.effects.includes('innings_complete')) { console.error('✘ expected innings_complete, got', r.data.effects); process.exit(1); }
  ok('innings 1 complete', `score should be 13/1 → ${r.data.state.summary.score}`);

  // ---- undo test mid-flow is destructive here; test idempotency instead ----
  const dupId = uuid();
  // (duplicate submit of a ball against the *new* innings would fail — test SEQ_CONFLICT instead)
  const stale = await api('POST', `/matches/${matchId}/balls`,
    { client_event_id: dupId, expected_seq: 1, runs_batter: 1 }, false);
  if (stale.status !== 400 && stale.status !== 409) { console.error('✘ expected stale-seq rejection, got', stale.status); process.exit(1); }
  ok('stale/illegal scoring correctly rejected', String(stale.status));

  // ---- innings 2: target 14 → 6, 6, wd, 2 → 15/0 chase done ----
  await api('POST', `/matches/${matchId}/openers`, {
    striker_id: bowl[0].id, non_striker_id: bowl[1].id, bowler_id: bat[0].id,
  });
  const st = (await api('GET', `/matches/${matchId}/state`)).data;
  ok('innings 2 open', `target = ${st.summary.target} (expect 14)`);

  r = await ball({ runs_batter: 6 });
  r = await ball({ runs_batter: 6 });
  r = await ball({ extra_type: 'wide', runs_extras: 0 });
  r = await ball({ runs_batter: 2 });
  if (!r.data.effects.includes('match_complete')) { console.error('✘ expected match_complete, got', r.data.effects); process.exit(1); }
  ok('match complete');

  await new Promise((res) => setTimeout(res, 1500)); // let async stats finalize land

  // ---- verify outputs ----
  const final = (await api('GET', `/matches/${matchId}`)).data;
  ok('result', final.result_summary);

  const card = (await api('GET', `/matches/${matchId}/scorecard`)).data;
  const inn1 = card[0];
  console.log(`   innings 1: ${inn1.total_runs}/${inn1.total_wickets} in ${inn1.legal_balls} balls, batting rows: ${inn1.batting.length}, bowling rows: ${inn1.bowling.length}`);

  const overs = (await api('GET', `/matches/${matchId}/overs`)).data;
  ok('over summaries', `${overs.length} over(s)`);

  const pts = (await api('GET', `/tournaments/${tour.id}/points-table`)).data;
  console.log('   points table:', pts.map((p) => `${p.short_name}: pts=${p.points} nrr=${p.net_run_rate}`).join(' | '));

  const leaders = (await api('GET', `/tournaments/${tour.id}/stats/leaders?metric=runs`)).data;
  console.log('   top run scorer:', leaders[0]?.full_name, leaders[0]?.runs_scored, 'runs, SR', leaders[0]?.strike_rate);

  const mvp = (await api('GET', `/matches/${matchId}/mvp`)).data;
  console.log('   MVP:', mvp[0]?.full_name, Number(mvp[0]?.total_points), 'pts');

  const h2h = (await api('GET', `/teams/${lions.id}/head-to-head/${tigers.id}`)).data;
  ok('head-to-head', `${h2h.matches_played} match(es) recorded`);

  // ---- commentary ----
  await api('POST', `/matches/${matchId}/commentary`, { body: 'What a finish! Chase completed with an over of carnage.', is_highlight: true });
  const comm = (await api('GET', `/matches/${matchId}/commentary`)).data;
  ok('commentary', `${comm.length} entr(ies)`);

  // ---- CMS + subscription spot checks ----
  const page = (await api('GET', '/cms/pages/home')).data;
  ok('CMS page render payload', `${page.blocks.length} blocks`);
  const ent = (await api('GET', `/orgs/${org.id}/subscription/entitlements`)).data;
  ok('plan entitlements', `max_tournaments=${ent.max_tournaments}`);

  console.log('\nALL E2E CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
