/* eslint-disable no-console */
/**
 * E2E: CRUD + permission enforcement for org/tournament/team/player/venue.
 * Owner (super_admin) can edit/delete everything; a viewer member is blocked (403);
 * org delete is owner-only and soft-deletes.
 * Usage: node scripts/e2e-permissions.js <ownerEmail> <ownerPassword>
 */
const BASE = 'http://localhost:3001/api/v1';
const [email, password] = process.argv.slice(2);
const run = Date.now().toString(36);
const ok = (l, e = '') => console.log(`✔ ${l}${e ? ' — ' + e : ''}`);
const fail = (m) => { console.error(`✘ ${m}`); process.exit(1); };

async function api(method, path, body, token, expect) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expect && res.status !== expect) fail(`${method} ${path} → ${res.status} (expected ${expect}) ${JSON.stringify(data)}`);
  if (!expect && !res.ok) fail(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return { status: res.status, data };
}

(async () => {
  const owner = (await api('POST', '/auth/login', { email, password })).data.access_token;
  ok('owner login');

  // A second, low-privilege user
  const viewerEmail = `viewer-${run}@example.com`;
  const viewer = (await api('POST', '/auth/register', { email: viewerEmail, password: 'ViewerPass!234', full_name: 'View Only' })).data.access_token;
  ok('registered viewer user');

  const org = (await api('POST', '/orgs', { name: 'Perm Club', slug: `e2e-club-perm-${run}` }, owner)).data;
  await api('POST', `/orgs/${org.id}/members`, { email: viewerEmail, role: 'viewer' }, owner);
  ok('viewer added to org as viewer role');

  // ---- Owner CRUD (should all pass) ----
  const formats = (await api('GET', '/formats', null, owner)).data;
  const t20 = formats.find((f) => f.slug === 't20' && f.is_builtin);
  const tour = (await api('POST', `/orgs/${org.id}/tournaments`, { name: 'Perm Cup', slug: `perm-cup-${run}`, format_id: t20.id }, owner)).data;
  await api('PATCH', `/tournaments/${tour.id}`, { name: 'Perm Cup Renamed' }, owner);
  ok('owner: tournament create + edit');

  const team = (await api('POST', `/orgs/${org.id}/teams`, { name: 'Perm Team', short_name: 'PTM', slug: `ptm-${run}` }, owner)).data;
  await api('PATCH', `/teams/${team.id}`, { name: 'Perm Team Renamed' }, owner);
  ok('owner: team create + edit');

  const player = (await api('POST', `/orgs/${org.id}/players`, { full_name: 'Perm Player', primary_role: 'batter' }, owner)).data;
  await api('PATCH', `/players/${player.id}`, { primary_role: 'all_rounder' }, owner);
  ok('owner: player create + edit');

  // Global player pool → assignable to any team; squad upsert + edit + remove
  await api('POST', `/teams/${team.id}/players`, { player_id: player.id, jersey_number: 7 }, owner);
  await api('POST', `/teams/${team.id}/players`, { player_id: player.id, jersey_number: 10, is_captain: true }, owner);
  const teamDetail = (await api('GET', `/teams/${team.id}`, null, owner)).data;
  if (teamDetail.squad?.[0]?.jersey_number !== 10 || !teamDetail.squad?.[0]?.is_captain) fail('squad upsert did not update jersey/captain');
  ok('owner: assign player to team + edit squad (jersey/captain)', `squad size ${teamDetail.squad.length}`);

  const venue = (await api('POST', `/orgs/${org.id}/venues`, { name: 'Perm Oval', city: 'Testville' }, owner)).data;
  await api('PATCH', `/orgs/${org.id}/venues/${venue.id}`, { city: 'Edited City' }, owner);
  ok('owner: venue create + edit');

  // ---- Viewer blocked (403) ----
  await api('PATCH', `/tournaments/${tour.id}`, { name: 'hax' }, viewer, 403);
  await api('DELETE', `/tournaments/${tour.id}`, null, viewer, 403);
  await api('PATCH', `/teams/${team.id}`, { name: 'hax' }, viewer, 403);
  await api('DELETE', `/teams/${team.id}`, null, viewer, 403);
  await api('POST', `/teams/${team.id}/players`, { player_id: player.id }, viewer, 403);
  await api('PATCH', `/players/${player.id}`, { primary_role: 'bowler' }, viewer, 403);
  await api('DELETE', `/players/${player.id}`, null, viewer, 403);
  await api('PATCH', `/orgs/${org.id}/venues/${venue.id}`, { city: 'hax' }, viewer, 403);
  await api('DELETE', `/orgs/${org.id}/venues/${venue.id}`, null, viewer, 403);
  await api('DELETE', `/orgs/${org.id}`, null, viewer, 403);
  ok('viewer: all edit/delete correctly blocked with 403');

  // Viewer can still read
  await api('GET', `/teams/${team.id}`, null, viewer, 200);
  await api('GET', `/orgs/${org.id}/venues`, null, viewer, 200);
  ok('viewer: reads still allowed');

  // ---- Owner deletes (should pass) ----
  await api('DELETE', `/teams/${team.id}/players/${player.id}`, null, owner);
  await api('DELETE', `/orgs/${org.id}/venues/${venue.id}`, null, owner);
  await api('DELETE', `/players/${player.id}`, null, owner);
  await api('DELETE', `/teams/${team.id}`, null, owner);
  await api('DELETE', `/tournaments/${tour.id}`, null, owner);
  ok('owner: deleted squad member, venue, player, team, tournament');

  // ---- Org delete (owner only) + gone from list ----
  await api('DELETE', `/orgs/${org.id}`, null, owner);
  const orgs = (await api('GET', '/orgs', null, owner)).data;
  if (orgs.some((o) => o.id === org.id)) fail('org still listed after delete');
  ok('owner: org soft-deleted and removed from list');

  console.log('\nALL PERMISSION/CRUD CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
