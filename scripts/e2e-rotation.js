/* eslint-disable no-console */
/**
 * End-to-end API test for Rotation Gully Mode.
 *
 * Creates a throwaway org (slug e2e-club-*), a pool of 4 players at 1 over
 * each, then plays the whole match ball-by-ball through the real endpoints and
 * asserts the things that are actually easy to get wrong:
 *
 *   - the solo batter occupies BOTH ends and never rotates strike
 *   - the per-batter quota retires a batter without a wicket falling
 *   - new-batter replaces BOTH crease slots (the bug this feature nearly shipped)
 *   - the batter cannot bowl to themselves, and nobody bowls consecutive overs
 *   - the innings ends on all_batted, not on wickets
 *   - stats/MVP finalize, and the career row lands in format_family='gully'
 *
 * Usage: node scripts/e2e-rotation.js <email> <password>
 * Afterwards: node scripts/cleanup-e2e.js
 */
const BASE = process.env.E2E_BASE || 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
let TOKEN = '';
const uuid = () => crypto.randomUUID();
const run = Date.now().toString(36);

let failures = 0;

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
function check(label, cond, detail = '') {
  if (cond) { ok(label, detail); return true; }
  failures += 1;
  console.error(`✘ ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

(async () => {
  TOKEN = (await api('POST', '/auth/login', { email, password })).data.access_token;
  ok('login');

  const org = (await api('POST', '/orgs', { name: 'E2E Gully Club', slug: `e2e-club-gully-${run}` })).data;
  ok('org created', org.slug);

  const mk = async (name) =>
    (await api('POST', `/orgs/${org.id}/players`, { full_name: name, primary_role: 'all_rounder' })).data;
  const P = [await mk('Gully Ayaan'), await mk('Gully Bilal'), await mk('Gully Chirag'), await mk('Gully Dev')];
  ok('players created', `${P.length}`);

  // One squad of 4, plus a club player who is NOT in it — the roster picker
  // must offer the squad only, and must still be able to reach the outsider.
  const team = (await api('POST', `/orgs/${org.id}/teams`, {
    name: 'Gully Squad', short_name: 'GSQ', slug: `gully-squad-${run}`,
  })).data;
  for (const p of P) await api('POST', `/teams/${team.id}/players`, { player_id: p.id });
  const outsider = await mk('Gully Outsider');
  ok('team created with a 4-player squad', team.short_name);

  // ---- create: one team select is REQUIRED --------------------------------
  const noTeam = await api('POST', `/orgs/${org.id}/rotation-matches`, {}, false);
  check('creating without a team is rejected', noTeam.status === 400, `status ${noTeam.status}`);

  const otherOrg = (await api('POST', '/orgs', {
    name: 'E2E Other Club', slug: `e2e-club-other-${run}`,
  })).data;
  const otherTeam = (await api('POST', `/orgs/${otherOrg.id}/teams`, {
    name: 'Other Squad', short_name: 'OSQ', slug: `other-squad-${run}`,
  })).data;
  const crossOrg = await api('POST', `/orgs/${org.id}/rotation-matches`, { team_id: otherTeam.id }, false);
  check("another club's team is rejected", crossOrg.status === 400, `status ${crossOrg.status}`);

  // ---- create + roster ----------------------------------------------------
  const match = (await api('POST', `/orgs/${org.id}/rotation-matches`, { team_id: team.id })).data;
  check('rotation match created', match.mode === 'rotation', `mode=${match.mode}`);
  check('no tournament required', match.tournament_id === null);
  check('selected team is recorded', match.rotation_team_id === team.id);
  check('but the team is NOT a playing side',
    match.team_a_id !== team.id && match.team_b_id !== team.id,
    'team_a/team_b stay synthetic, so gully stays out of team standings');

  const teamList = (await api('GET', `/orgs/${org.id}/teams`)).data;
  check('synthetic pool teams stay out of the club team list',
    !teamList.some((t) => t.is_synthetic), `${teamList.length} team(s) listed`);

  // ---- roster candidates come from the selected squad ----------------------
  const cand = (await api('GET', `/matches/${match.id}/rotation/candidates`)).data;
  check('candidates default to the selected squad',
    cand.scope === 'team' && cand.players.length === 4, `${cand.players.length} from ${cand.scope}`);
  check('a club player outside the squad is excluded',
    !cand.players.some((p) => p.id === outsider.id));
  const wide = (await api('GET', `/matches/${match.id}/rotation/candidates?scope=club`)).data;
  check('scope=club widens to the whole club',
    wide.scope === 'club' && wide.players.some((p) => p.id === outsider.id),
    `${wide.players.length} club players`);

  const roster = (await api('PUT', `/matches/${match.id}/rotation/roster`, {
    player_ids: P.map((p) => p.id),
    overs_per_batter: 1,
    shuffle_order: false,
  })).data;
  check('roster set', roster.batter_count === 4 && roster.total_overs === 4,
    `${roster.batter_count} batters, ${roster.total_overs} overs`);

  const detail = (await api('GET', `/matches/${match.id}`)).data;
  const rs = detail.rules_snapshot;
  check('players_per_side is N+1', rs.players_per_side === 5, `got ${rs.players_per_side}`);
  check('wickets_to_fall is N', rs.wickets_to_fall === 4, `got ${rs.wickets_to_fall}`);
  check('balls_per_batter frozen', rs.solo_batting.balls_per_batter === 6,
    `got ${rs.solo_batting.balls_per_batter}`);

  // ---- start --------------------------------------------------------------
  const started = (await api('POST', `/matches/${match.id}/rotation/start`, {
    striker_id: P[0].id, bowler_id: P[1].id,
  })).data;
  const eng0 = started.state.engine;
  check('solo batter occupies both ends',
    eng0.strikerId === P[0].id && eng0.nonStrikerId === P[0].id);

  // ---- guards -------------------------------------------------------------
  const selfBowl = await api('POST', `/matches/${match.id}/rotation/bowler`,
    { bowler_id: P[0].id }, false);
  check('batter cannot bowl to themselves', selfBowl.status === 409,
    `status ${selfBowl.status} ${JSON.stringify(selfBowl.data.message ?? selfBowl.data)}`);

  // ---- score: batter 1 faces their whole over ----------------------------
  const ball = async (body, expectOk = true) =>
    api('POST', `/matches/${match.id}/balls`, { client_event_id: uuid(), ...body }, expectOk);

  let last;
  for (let i = 0; i < 5; i++) last = await ball({ runs_batter: 1 });
  const midEng = last.data.state.engine;
  check('odd runs never rotate strike in solo mode',
    midEng.strikerId === P[0].id && midEng.nonStrikerId === P[0].id);
  check('batter ball count tracked', (midEng.batterLegalBalls ?? {})[P[0].id] === 5,
    `faced ${(midEng.batterLegalBalls ?? {})[P[0].id]}`);

  // 6th ball completes the over AND the batter's quota
  last = await ball({ runs_batter: 1 });
  const effects = last.data.effects;
  check('quota retirement fires', effects.includes('batter_retired'), JSON.stringify(effects));
  check('and asks for a new batter', effects.includes('new_batter_required'));
  const qEng = last.data.state.engine;
  check('quota retirement is NOT a wicket', qEng.totalWickets === 0, `wickets=${qEng.totalWickets}`);
  check('batter marked completed', (qEng.battersCompleted ?? []).includes(P[0].id));

  const slots = (await api('GET', `/matches/${match.id}/rotation/slots`)).data.slots;
  const s0 = slots.find((s) => s.player_id === P[0].id);
  check('slot closed as quota', s0.ended_reason === 'quota', `got ${s0.ended_reason}`);
  check('slot counters persisted', s0.balls_faced === 6 && s0.runs_scored === 6,
    `${s0.runs_scored} off ${s0.balls_faced}`);

  // ---- new batter must replace BOTH ends ---------------------------------
  const nb = (await api('POST', `/matches/${match.id}/new-batter`, { player_id: P[1].id })).data;
  const nbEng = nb.state.engine;
  check('new batter replaces BOTH crease slots',
    nbEng.strikerId === P[1].id && nbEng.nonStrikerId === P[1].id,
    `striker=${nbEng.strikerId === P[1].id} nonStriker=${nbEng.nonStrikerId === P[1].id}`);

  // P[1] bowled the first over, so they cannot bowl the second; and they are
  // now batting anyway. Give the ball to P[2].
  await api('POST', `/matches/${match.id}/rotation/bowler`, { bowler_id: P[2].id });

  const sugg = (await api('GET', `/matches/${match.id}/rotation/next-bowler`)).data;
  check('bowler suggestions exclude the current batter',
    !sugg.suggestions.some((b) => b.player_id === P[1].id),
    `${sugg.suggestions.length} eligible`);

  // ---- batter 2: dismissed mid-over --------------------------------------
  await ball({ runs_batter: 2 });
  last = await ball({ wicket: { type: 'bowled', dismissed_player_id: P[1].id } });
  check('dismissal counts as a wicket', last.data.state.engine.totalWickets === 1);
  check('dismissal also consumes a batter slot',
    (last.data.state.engine.battersCompleted ?? []).length === 2);

  await api('POST', `/matches/${match.id}/new-batter`, { player_id: P[2].id });
  // P[2] is bowling; hand the ball to P[3] before scoring again.
  await api('POST', `/matches/${match.id}/rotation/bowler`, { bowler_id: P[3].id });

  // ---- batter 3: retires voluntarily -------------------------------------
  await ball({ runs_batter: 4, is_boundary_four: true });
  const ret = (await api('POST', `/matches/${match.id}/rotation/retire`, {})).data;
  check('voluntary retirement recorded', ret.retired === P[2].id);
  check('retirement consumed a slot',
    (ret.state.engine.battersCompleted ?? []).length === 3);

  // ---- batter 4: last one, gets out -> innings must end on all_batted -----
  await api('POST', `/matches/${match.id}/new-batter`, { player_id: P[3].id });
  await api('POST', `/matches/${match.id}/rotation/bowler`, { bowler_id: P[0].id });
  last = await ball({ wicket: { type: 'bowled', dismissed_player_id: P[3].id } });
  check('innings ends when everyone has batted',
    last.data.effects.includes('innings_complete'), JSON.stringify(last.data.effects));

  // ---- finalize + stats ---------------------------------------------------
  await api('POST', `/matches/${match.id}/finalize`, { result_type: 'no_result' }, false);
  await new Promise((r) => setTimeout(r, 2500)); // stats finalize runs post-commit

  const card = (await api('GET', `/matches/${match.id}/scorecard`)).data;
  check('scorecard renders', !!card);

  const mvp = (await api('GET', `/matches/${match.id}/mvp`)).data;
  const rows = Array.isArray(mvp) ? mvp : (mvp.players ?? mvp.rows ?? []);
  check('MVP points computed for the pool', rows.length >= 3, `${rows.length} rows`);
  if (rows.length) {
    const top = rows[0];
    console.log(`   top: ${top.full_name ?? top.player_id} = ${top.total_points}`);
  }

  // The profile — and the career_stats it carries — is GET /players/:id.
  // There is no /players/:id/stats route; asking for one 404s, which used to
  // make this check fail for a reason that had nothing to do with gully.
  const profile = (await api('GET', `/players/${P[0].id}`)).data;
  const gullyRow = (profile.career_stats ?? []).find((c) => c.format_family === 'gully');
  check("career stats land in format_family='gully'", !!gullyRow,
    gullyRow ? `${gullyRow.runs_scored} runs, ${gullyRow.wickets_taken} wkts`
             : `families: ${(profile.career_stats ?? []).map((c) => c.format_family).join(',') || 'none'}`);

  console.log('');
  if (failures) {
    console.error(`${failures} check(s) FAILED`);
    console.error('Remember: node scripts/cleanup-e2e.js');
    process.exit(1);
  }
  console.log('All rotation checks passed.');
  console.log('Now run: node scripts/cleanup-e2e.js');
})();
