#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Repro: gully over count after a mid-over dismissal.
 *
 * Scenario the scorer reported:
 *   3 legal balls bowled (0.3), batter out, new batter + "start new over",
 *   the new bowler bowls a full 6, and the innings should read 1.3 (9 legal
 *   balls) — not 1.0.
 *
 * Prints the overs figure after every step so the drift is visible.
 *
 * Usage: node scripts/e2e-gully-overs.js <email> [new_over|continue_over]
 */

require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const API = process.env.E2E_API ?? 'http://localhost:3001/api/v1';
const email = process.argv[2];
const OVER_ACTION = process.argv[3] ?? 'new_over';
if (!email) {
  console.error('usage: node scripts/e2e-gully-overs.js <email> [new_over|continue_over]');
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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

(async () => {
  const client = await pool.connect();
  const stamp = Date.now().toString(36);
  let orgId = null;

  const show = async (label) => {
    const s = await call(`/matches/${MATCH}/state`);
    const e = s.engine ?? {};
    console.log(
      `  ${label.padEnd(26)} overs=${String(s.summary?.overs).padEnd(5)} ` +
      `legalBalls=${e.legalBalls} currentOverBalls=${e.currentOverBalls} ` +
      `lastOverBowler=${e.lastOverBowlerId ? e.lastOverBowlerId.slice(0, 8) : 'null'}`,
    );
    return s;
  };
  let MATCH = null;

  try {
    const u = (await client.query('SELECT id, email FROM users WHERE email = $1', [email])).rows[0];
    if (!u) throw new Error(`No user ${email}`);
    const roles = (await client.query(
      `SELECT r.slug FROM user_role_assignments a JOIN roles r ON r.id = a.role_id WHERE a.user_id = $1`,
      [u.id],
    )).rows.map((r) => r.slug);
    TOKEN = jwt.sign({ sub: u.id, email: u.email, roles }, process.env.JWT_SECRET, { expiresIn: '30m' });

    orgId = (await client.query(
      `INSERT INTO organizations (name, slug, owner_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [`e2e-club-${stamp}`, `e2e-club-${stamp}`, u.id],
    )).rows[0].id;
    const teamId = (await client.query(
      `INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic)
       VALUES ($1, $2, $3, $4, false) RETURNING id`,
      [orgId, `E2E Overs ${stamp}`, 'EOV', `e2e-overs-${stamp}`],
    )).rows[0].id;
    const players = [];
    for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      const pid = (await client.query(
        `INSERT INTO players (organization_id, full_name) VALUES ($1, $2) RETURNING id`,
        [orgId, `${n} ${stamp}`],
      )).rows[0].id;
      await client.query(`INSERT INTO team_players (team_id, player_id) VALUES ($1, $2)`, [teamId, pid]);
      players.push(pid);
    }

    const match = await call(`/orgs/${orgId}/rotation-matches`, {
      method: 'POST', body: { team_id: teamId },
    });
    MATCH = match.id ?? match.match?.id;

    await call(`/matches/${MATCH}/rotation/roster`, {
      method: 'PUT',
      body: { player_ids: players, overs_per_batter: 3, shuffle_order: false },
    });
    const { slots } = await call(`/matches/${MATCH}/rotation/slots`);
    const opener = slots.find((s) => s.bat_order === 1) ?? slots[0];
    const bowlerA = slots.find((s) => s.player_id !== opener.player_id);
    await call(`/matches/${MATCH}/rotation/start`, {
      method: 'POST', body: { bowler_id: bowlerA.player_id },
    });
    console.log(`\n▶ over_action = ${OVER_ACTION}\n`);
    await show('start');

    // ---- 3 legal balls -> 0.3 -------------------------------------------
    for (const runs of [1, 1, 1]) {
      await call(`/matches/${MATCH}/balls`, {
        method: 'POST',
        body: { client_event_id: crypto.randomUUID(), bowler_id: bowlerA.player_id, runs_batter: runs },
      });
    }
    await show('after 3 balls');

    // ---- wicket on the 4th ball -> batter out ---------------------------
    await call(`/matches/${MATCH}/balls`, {
      method: 'POST',
      body: {
        client_event_id: crypto.randomUUID(),
        bowler_id: bowlerA.player_id,
        wicket: { type: 'bowled' },
      },
    });
    const afterW = await show('after wicket (0.4)');
    const ballsAtWicket = afterW.engine.legalBalls;

    // ---- new batter, user picks "start new over" ------------------------
    const nextBat = slots.find(
      (s) => s.player_id !== opener.player_id && s.player_id !== bowlerA.player_id,
    );
    await call(`/matches/${MATCH}/new-batter`, {
      method: 'POST',
      body: { player_id: nextBat.player_id, over_action: OVER_ACTION },
    });
    await show(`after new-batter`);

    // ---- a different bowler bowls a full 6 ------------------------------
    const bowlerB = slots.find(
      (s) => s.player_id !== bowlerA.player_id && s.player_id !== nextBat.player_id,
    );
    await call(`/matches/${MATCH}/rotation/bowler`, {
      method: 'POST', body: { bowler_id: bowlerB.player_id },
    });
    // A real scorer hands the ball on at each over boundary; the engine
    // rejects the same bowler twice running, so mirror that here.
    let current = bowlerB.player_id;
    for (let i = 0; i < 6; i++) {
      const s = await call(`/matches/${MATCH}/state`);
      if (s.engine.currentOverBalls === 0 && s.engine.lastOverBowlerId === current) {
        const { suggestions } = await call(`/matches/${MATCH}/rotation/next-bowler`);
        const pick = suggestions.find((b) => b.player_id !== s.engine.strikerId);
        if (!pick) throw new Error('nobody eligible to bowl');
        current = pick.player_id;
        await call(`/matches/${MATCH}/rotation/bowler`, {
          method: 'POST', body: { bowler_id: current },
        });
      }
      await call(`/matches/${MATCH}/balls`, {
        method: 'POST',
        body: { client_event_id: crypto.randomUUID(), bowler_id: current, runs_batter: 0 },
      });
      await show(`  ball ${i + 1}`);
    }

    const final = await call(`/matches/${MATCH}/state`);
    const expectedBalls = ballsAtWicket + 6;
    const bpo = 6;
    const expectedOvers = `${Math.floor(expectedBalls / bpo)}.${expectedBalls % bpo}`;
    console.log(
      `\n  expected overs=${expectedOvers} (${expectedBalls} legal balls)  ` +
      `actual overs=${final.summary?.overs} (${final.engine?.legalBalls} legal balls)`,
    );

    // over_number distribution on the ball rows — a collision here would
    // silently overwrite an over_summaries row.
    const rows = (await client.query(
      `SELECT over_number, count(*)::int AS balls, count(*) FILTER (WHERE is_legal)::int AS legal
         FROM balls WHERE innings_id = $1 AND NOT is_superseded
        GROUP BY over_number ORDER BY over_number`,
      [final.innings_id],
    )).rows;
    console.log('  over_number distribution:',
      rows.map((r) => `over ${r.over_number}: ${r.legal} legal`).join(' | '));

    if (final.summary?.overs !== expectedOvers) {
      console.log(`\n❌ MISMATCH — shows ${final.summary?.overs}, should be ${expectedOvers}`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ overs correct: ${expectedOvers}`);
    }
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    if (orgId) {
      try {
        await client.query('DELETE FROM matches WHERE organization_id = $1', [orgId]);
        await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
        console.log('✔ cleaned up');
      } catch (e) {
        console.error('cleanup failed:', e.message, 'org:', orgId);
      }
    }
    client.release();
    await pool.end();
  }
})();
