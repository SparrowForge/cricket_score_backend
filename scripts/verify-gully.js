#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Verify gully match creation: test the database layer directly
 * to confirm rotation_team_id is being set correctly.
 */

require('dotenv').config();
const {Pool} = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {rejectUnauthorized: false},
});

(async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Get a user
    const userRes = await client.query('SELECT id FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      console.error('✗ No users in database');
      process.exit(1);
    }
    const userId = userRes.rows[0].id;

    // Create test org
    const now = Date.now().toString(36);
    const orgRes = await client.query(
      'INSERT INTO organizations (name, slug, owner_user_id) VALUES ($1, $2, $3) RETURNING id',
      [`GullyTest${now}`, `gully-test-${now}`, userId]
    );
    const orgId = orgRes.rows[0].id;
    console.log('✔ Test org created:', orgId);

    // Create a real team
    const teamRes = await client.query(
      'INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic) VALUES ($1, $2, $3, $4, false) RETURNING id, is_synthetic',
      [orgId, 'TestTeam', 'TST', `team-${now}`]
    );
    const teamId = teamRes.rows[0].id;
    console.log('✔ Real team created:', teamId, '(is_synthetic:', teamRes.rows[0].is_synthetic + ')');

    // Create synthetic pool and field teams (as RotationService.ensurePoolTeams does)
    const poolRes = await client.query(
      'INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic) VALUES ($1, $2, $3, $4, true) RETURNING id',
      [orgId, 'Gully Pool', 'POOL', 'gully-pool']
    );
    const poolId = poolRes.rows[0].id;

    const fieldRes = await client.query(
      'INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic) VALUES ($1, $2, $3, $4, true) RETURNING id',
      [orgId, 'Gully Field', 'FIELD', 'gully-field']
    );
    const fieldId = fieldRes.rows[0].id;
    console.log('✔ Synthetic teams created: pool=' + poolId + ', field=' + fieldId);

    // Now create the match (exactly as RotationService.createMatch does)
    console.log('\n▶ Creating rotation match...');
    const matchRes = await client.query(
      `INSERT INTO matches (tournament_id, organization_id, mode, match_number, stage,
                            team_a_id, team_b_id, rotation_team_id, venue_id, scheduled_start)
       VALUES (NULL, $1, 'rotation', NULL, 'custom', $2, $3, $4, NULL, now())
       RETURNING id, mode, status, tournament_id, team_a_id, team_b_id, rotation_team_id, stage`,
      [orgId, poolId, fieldId, teamId]
    );
    const match = matchRes.rows[0];

    console.log('✔ Match created successfully!');
    console.log('  id:', match.id);
    console.log('  mode:', match.mode);
    console.log('  status:', match.status);
    console.log('  tournament_id:', match.tournament_id);
    console.log('  stage:', match.stage);
    console.log('  team_a_id:', match.team_a_id, '(pool)');
    console.log('  team_b_id:', match.team_b_id, '(field)');
    console.log('  rotation_team_id:', match.rotation_team_id, '(real team)');

    // Verify the match can be fetched back
    const fetchRes = await client.query(
      'SELECT id, mode, rotation_team_id FROM matches WHERE id = $1',
      [match.id]
    );
    if (fetchRes.rows.length === 0) {
      console.error('✗ Match not found on refetch!');
      process.exit(1);
    }
    const fetched = fetchRes.rows[0];
    if (fetched.rotation_team_id !== teamId) {
      console.error('✗ rotation_team_id mismatch!', 'expected:', teamId, 'got:', fetched.rotation_team_id);
      process.exit(1);
    }
    console.log('\n✔ Match verification passed!');

    // ROLLBACK to not pollute the database
    await client.query('ROLLBACK');
    console.log('✔ Transaction rolled back');

  } catch (err) {
    console.error('\n✗ Error:', err.message);
    console.error('  Code:', err.code);
    if (client) await client.query('ROLLBACK').catch(() => {});
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
})();
