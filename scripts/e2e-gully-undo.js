#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Regression: undoing a ball in a gully (rotation) match must roll back the
 * per-player runs the console's ranking table reads.
 *
 * rotation_slots.runs_scored / balls_faced are incremented in place per ball,
 * so before the replayInnings rebuild they survived an undo and the ranking
 * kept showing the pre-undo total.
 *
 * Usage: node scripts/e2e-gully-undo.js <email> [password]
 *   With no password, mints a JWT from JWT_SECRET (see .claude/skills/verify).
 */

require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const API = process.env.E2E_API ?? 'http://localhost:3001/api/v1';
const email = process.argv[2];
if (!email) {
  console.error('usage: node scripts/e2e-gully-undo.js <email>');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let TOKEN = null;
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return json;
}

function ranking(state) {
  return (state?.rotation?.slots ?? []).map(
    (s) => `${s.name}: ${s.runs_scored} (${s.balls_faced})`,
  );
}

(async () => {
  const client = await pool.connect();
  const stamp = Date.now().toString(36);
  let orgId = null;

  try {
    // ---- auth: mint a JWT rather than logging in -------------------------
    const u = (await client.query(
      'SELECT id, email FROM users WHERE email = $1', [email],
    )).rows[0];
    if (!u) throw new Error(`No user with email ${email}`);
    const roles = (await client.query(
      `SELECT r.slug FROM user_role_assignments a
         JOIN roles r ON r.id = a.role_id WHERE a.user_id = $1`, [u.id],
    )).rows.map((r) => r.slug);
    TOKEN = jwt.sign({ sub: u.id, email: u.email, roles }, process.env.JWT_SECRET,
      { expiresIn: '30m' });
    console.log('✔ token minted for', u.email, roles.length ? `(${roles})` : '');

    // ---- throwaway org + team + players ----------------------------------
    orgId = (await client.query(
      `INSERT INTO organizations (name, slug, owner_user_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`e2e-club-${stamp}`, `e2e-club-${stamp}`, u.id],
    )).rows[0].id;
    const teamId = (await client.query(
      `INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic)
       VALUES ($1, $2, $3, $4, false) RETURNING id`,
      [orgId, `E2E Gully ${stamp}`, 'EGU', `e2e-gully-${stamp}`],
    )).rows[0].id;

    const players = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      const pid = (await client.query(
        `INSERT INTO players (organization_id, full_name) VALUES ($1, $2) RETURNING id`,
        [orgId, `${name} ${stamp}`],
      )).rows[0].id;
      await client.query(
        `INSERT INTO team_players (team_id, player_id) VALUES ($1, $2)`,
        [teamId, pid],
      );
      players.push({ id: pid, name });
    }
    console.log('✔ org/team/players created:', orgId);

    // ---- create the gully match via the real endpoint ---------------------
    const match = await call(`/orgs/${orgId}/rotation-matches`, {
      method: 'POST',
      body: { team_id: teamId },
    });
    const matchId = match.id ?? match.match?.id;
    console.log('✔ rotation match:', matchId);

    await call(`/matches/${matchId}/rotation/roster`, {
      method: 'PUT',
      body: {
        player_ids: players.map((p) => p.id),
        overs_per_batter: 2,
        shuffle_order: false,
      },
    });
    // bat_order 1 opens; anyone else can bowl to them.
    const { slots } = await call(`/matches/${matchId}/rotation/slots`);
    const opener = slots.find((s) => s.bat_order === 1) ?? slots[0];
    const bowler = slots.find((s) => s.player_id !== opener.player_id);
    await call(`/matches/${matchId}/rotation/start`, {
      method: 'POST', body: { bowler_id: bowler.player_id },
    });
    console.log('✔ roster saved + match started');

    const state = await call(`/matches/${matchId}/state`);
    const strikerId = state.engine.strikerId;

    // ---- score three balls: 4, 2, 1 = 7 runs off 3 balls ------------------
    for (const runs of [4, 2, 1]) {
      await call(`/matches/${matchId}/balls`, {
        method: 'POST',
        body: {
          client_event_id: crypto.randomUUID(),
          bowler_id: bowler.player_id,
          runs_batter: runs,
          is_boundary_four: runs === 4,
          is_boundary_six: false,
          // the field that used to be rejected by BallDto
          shot_placement: {
            region: 'square_leg', label: 'Square Leg',
            angle_deg: -77, distance_pct: 66, six: false,
          },
        },
      });
    }
    console.log('✔ shot_placement accepted on all three balls');

    const before = await call(`/matches/${matchId}/state`);
    const beforeSlot = before.rotation.slots.find((s) => s.player_id === strikerId);
    console.log('  after 4,2,1 →', ranking(before).join(' | '));

    if (beforeSlot.runs_scored !== 7 || beforeSlot.balls_faced !== 3) {
      throw new Error(
        `pre-undo wrong: expected 7 (3), got ${beforeSlot.runs_scored} (${beforeSlot.balls_faced})`,
      );
    }

    // ---- undo the last ball (the single) ---------------------------------
    await call(`/matches/${matchId}/balls/last`, { method: 'DELETE' });
    const after = await call(`/matches/${matchId}/state`);
    const afterSlot = after.rotation.slots.find((s) => s.player_id === strikerId);
    console.log('  after undo   →', ranking(after).join(' | '));

    if (afterSlot.runs_scored !== 6 || afterSlot.balls_faced !== 2) {
      throw new Error(
        `THE BUG: ranking did not roll back — expected 6 (2), got ` +
        `${afterSlot.runs_scored} (${afterSlot.balls_faced})`,
      );
    }
    console.log('✔ ranking rolled back correctly: 7 (3) → 6 (2)');

    // ---- undo back to zero, confirm it keeps tracking ---------------------
    await call(`/matches/${matchId}/balls/last`, { method: 'DELETE' });
    const after2 = await call(`/matches/${matchId}/state`);
    const slot2 = after2.rotation.slots.find((s) => s.player_id === strikerId);
    console.log('  after undo 2 →', ranking(after2).join(' | '));
    if (slot2.runs_scored !== 4 || slot2.balls_faced !== 1) {
      throw new Error(
        `second undo wrong: expected 4 (1), got ${slot2.runs_scored} (${slot2.balls_faced})`,
      );
    }
    console.log('✔ second undo correct: 6 (2) → 4 (1)');

    console.log('\n✅ PASS — gully undo rolls back the ranking table');
  } catch (err) {
    console.error('\n❌ FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    if (orgId) {
      // match_players references teams, so matches must go before the org
      // cascade reaches the teams rows.
      try {
        await client.query('DELETE FROM matches WHERE organization_id = $1', [orgId]);
        await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
        console.log('✔ cleaned up test org');
      } catch (e) {
        console.error('cleanup failed:', e.message, '- org left behind:', orgId);
      }
    }
    client.release();
    await pool.end();
  }
})();
