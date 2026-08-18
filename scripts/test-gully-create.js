/* eslint-disable no-console */
/**
 * Test gully match creation flow
 * Creates an org, team, players, then attempts to create a gully match
 */
const BASE = 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
let TOKEN = '';
const uuid = () => crypto.randomUUID();
const run = Date.now().toString(36);

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
  try {
    // ---- Auth ----
    TOKEN = (await api('POST', '/auth/login', { email, password })).data.access_token;
    ok('login');

    // ---- Create org and team ----
    const org = (await api('POST', '/orgs', { name: 'Gully Test Club', slug: `gully-test-${run}` })).data;
    ok('org created', org.slug);

    const team = (await api('POST', `/orgs/${org.id}/teams`, {
      name: 'Gully Team',
      short_name: 'GLY',
      slug: `gully-team-${run}`
    })).data;
    ok('team created', team.id);

    // ---- Create players ----
    const mk = async (name, role) =>
      (await api('POST', `/orgs/${org.id}/players`, { full_name: name, primary_role: role })).data;

    const p1 = await mk('Batter One', 'batter');
    const p2 = await mk('Batter Two', 'batter');
    const p3 = await mk('All Rounder', 'all_rounder');
    ok('players created', '3');

    // ---- Add players to team squad ----
    for (const player of [p1, p2, p3]) {
      await api('POST', `/orgs/${org.id}/teams/${team.id}/players`, { player_id: player.id });
    }
    ok('players added to squad');

    // ---- Create gully match ----
    console.log('\n▶ Creating gully match with team:', team.id);
    const matchRes = await api('POST', `/orgs/${org.id}/rotation-matches`, { team_id: team.id });
    const match = matchRes.data;

    if (!match.id) {
      console.error('✘ No match ID returned:', match);
      process.exit(1);
    }

    ok('gully match created', match.id);
    console.log('  mode:', match.mode);
    console.log('  status:', match.status);
    console.log('  rotation_team_id:', match.rotation_team_id);
    console.log('  team_a_id:', match.team_a_id);
    console.log('  team_b_id:', match.team_b_id);

    // ---- Verify match exists ----
    const fetched = (await api('GET', `/matches/${match.id}`)).data;
    ok('match fetched', fetched.id);
    console.log('  Fetched mode:', fetched.mode);
    console.log('  Fetched status:', fetched.status);

    ok('✓ Gully match creation test PASSED');

  } catch (err) {
    console.error('✘ Error:', err.message);
    process.exit(1);
  }
})();
