/* eslint-disable no-console */
/**
 * Seeds a demo org + teams + players + tournament + one scheduled match
 * so the frontend has real data. Prints the match id.
 * Usage: node scripts/seed-demo.js <email> <password>
 */
const BASE = 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
let TOKEN = '';

async function api(method, path, body, okStatuses = []) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !okStatuses.includes(res.status)) {
    console.error(`${method} ${path} → ${res.status}`, JSON.stringify(data));
    process.exit(1);
  }
  return data;
}

(async () => {
  TOKEN = (await api('POST', '/auth/login', { email, password })).access_token;

  // Org (reuse if it exists)
  let org = (await api('GET', '/orgs')).find((o) => o.slug === 'demo-league');
  if (!org) org = await api('POST', '/orgs', { name: 'Demo Cricket League', slug: 'demo-league' });
  console.log('org:', org.id);

  const teams = await api('GET', `/orgs/${org.id}/teams`);
  const mkTeam = async (name, short, slug) =>
    teams.find((t) => t.slug === slug) ?? api('POST', `/orgs/${org.id}/teams`, { name, short_name: short, slug });
  const royals = await mkTeam('Riverside Royals', 'RRS', 'riverside-royals');
  const titans = await mkTeam('Townend Titans', 'TTN', 'townend-titans');

  const existing = await api('GET', `/orgs/${org.id}/players`);
  const mkPlayer = async (name, role, teamId) => {
    let p = existing.find((x) => x.full_name === name);
    if (!p) p = await api('POST', `/orgs/${org.id}/players`, { full_name: name, primary_role: role });
    await api('POST', `/teams/${teamId}/players`, { player_id: p.id });
    return p;
  };
  const royalsNames = [['Arif Khan', 'batter'], ['Basit Ali', 'batter'], ['Chirag Rao', 'all_rounder'], ['Dan Wells', 'wicket_keeper_batter'], ['Emon Das', 'bowler']];
  const titansNames = [['Farhan Alam', 'batter'], ['Gary Hobbs', 'batter'], ['Hasan Raja', 'all_rounder'], ['Imran Sheikh', 'wicket_keeper_batter'], ['Junaid Mir', 'bowler']];
  for (const [n, r] of royalsNames) await mkPlayer(n, r, royals.id);
  for (const [n, r] of titansNames) await mkPlayer(n, r, titans.id);
  console.log('players: 10 seeded');

  const venues = await api('GET', `/orgs/${org.id}/venues`);
  const venue = venues[0] ?? (await api('POST', `/orgs/${org.id}/venues`, { name: 'Demo Oval', city: 'Dhaka' }));

  const tours = await api('GET', `/tournaments?org=${org.id}`);
  let tour = tours.find((t) => t.slug === 'demo-t20-bash');
  if (!tour) {
    const formats = await api('GET', '/formats');
    const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
    tour = await api('POST', `/orgs/${org.id}/tournaments`, {
      name: 'Demo T20 Bash', slug: 'demo-t20-bash', format_id: t20.id,
      rule_overrides: { overs_per_innings: 5, max_overs_per_bowler: 2 },
    });
  }
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: royals.id });
  await api('POST', `/tournaments/${tour.id}/teams`, { team_id: titans.id });
  console.log('tournament:', tour.id);

  const match = await api('POST', `/orgs/${org.id}/matches`, {
    tournament_id: tour.id, team_a_id: royals.id, team_b_id: titans.id,
    venue_id: venue.id, scheduled_start: new Date().toISOString(),
  });
  console.log('MATCH:', match.id);
})();
