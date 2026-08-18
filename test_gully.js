require('dotenv').config();
const {Pool} = require('pg');
const pool = new Pool({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});

(async () => {
  let client;
  try {
    client = await pool.connect();
    
    // Start transaction
    await client.query('BEGIN');
    
    // Create test org
    const orgRes = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Test Gully Org ${Date.now()}`, `test-gully-${Date.now()}`]
    );
    const orgId = orgRes.rows[0].id;
    console.log('✓ Created org:', orgId);
    
    // Create a real team (not synthetic)
    const teamRes = await client.query(
      `INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic)
       VALUES ($1, $2, $3, $4, false) RETURNING id, name, is_synthetic`,
      [orgId, 'Test Team', 'TST', `test-team-${Date.now()}`, false]
    );
    const teamId = teamRes.rows[0].id;
    console.log('✓ Created team:', teamId, '- is_synthetic:', teamRes.rows[0].is_synthetic);
    
    // Create synthetic pool/field teams (like rotation.service does)
    const poolRes = await client.query(
      `INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic)
       VALUES ($1, 'Gully Pool', 'POOL', 'gully-pool-' || $2, true) 
       RETURNING id`,
      [orgId, Date.now()]
    );
    const poolId = poolRes.rows[0].id;
    console.log('✓ Created pool team:', poolId);
    
    const fieldRes = await client.query(
      `INSERT INTO teams (organization_id, name, short_name, slug, is_synthetic)
       VALUES ($1, 'Gully Field', 'FIELD', 'gully-field-' || $2, true) 
       RETURNING id`,
      [orgId, Date.now()]
    );
    const fieldId = fieldRes.rows[0].id;
    console.log('✓ Created field team:', fieldId);
    
    // Try to create rotation match (like rotation.service.createMatch does)
    console.log('\nAttempting to create gully match...');
    console.log('  orgId:', orgId);
    console.log('  team_a_id (pool):', poolId);
    console.log('  team_b_id (field):', fieldId);
    console.log('  rotation_team_id (real team):', teamId);
    
    try {
      const matchRes = await client.query(
        `INSERT INTO matches (tournament_id, organization_id, mode, match_number, stage,
                              team_a_id, team_b_id, rotation_team_id, venue_id, scheduled_start)
         VALUES (NULL, $1, 'rotation', NULL, 'custom', $2, $3, $4, NULL, now())
         RETURNING id, mode, rotation_team_id, team_a_id, team_b_id`,
        [orgId, poolId, fieldId, teamId]
      );
      const match = matchRes.rows[0];
      console.log('\n✓ Match created successfully!');
      console.log('  id:', match.id);
      console.log('  mode:', match.mode);
      console.log('  team_a_id:', match.team_a_id);
      console.log('  team_b_id:', match.team_b_id);
      console.log('  rotation_team_id:', match.rotation_team_id);
    } catch (err) {
      console.log('\n✗ Match creation failed:');
      console.log('  Error:', err.message);
      console.log('  Code:', err.code);
    }
    
    // ROLLBACK so we don't pollute the DB
    await client.query('ROLLBACK');
    console.log('\n✓ Transaction rolled back');
    
  } catch (err) {
    console.error('\n✗ Fatal error:', err.message);
    if (client) await client.query('ROLLBACK').catch(() => {});
  } finally {
    if (client) client.release();
    await pool.end();
  }
})();
