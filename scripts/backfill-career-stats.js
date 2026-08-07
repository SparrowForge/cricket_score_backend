#!/usr/bin/env node
/**
 * Backfill newly added columns in player_career_stats table.
 * Updates: ducks, thirties, twenties, maidens, two/three/four_wkt_hauls
 *
 * Usage:
 *   node scripts/backfill-career-stats.js [--apply]
 *
 * Default: dry-run (shows what would be updated)
 * --apply: actually updates the database
 */

const { Pool } = require('pg');
require('dotenv').config();

const apply = process.argv.includes('--apply');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function backfillCareerStats() {
  console.log(apply ? '🔄 Applying backfill...' : '🔍 Dry-run mode (use --apply to write)');

  try {
    if (!apply) {
      await pool.query('BEGIN');
      console.log('\n📊 Starting transaction (will ROLLBACK)...\n');
    }

    // Get all player+format combinations from player_career_stats
    const players = await pool.query(`
      SELECT DISTINCT player_id, format_family
      FROM player_career_stats
      ORDER BY player_id, format_family
    `);

    console.log(`Found ${players.rows.length} player-format combinations\n`);

    let updated = 0;

    for (const row of players.rows) {
      const { player_id, format_family } = row;

      // Calculate ducks (0 runs, batted) - across all matches since career_stats is aggregated
      const ducksResult = await pool.query(`
        SELECT COUNT(*)::int as count FROM player_match_stats
        WHERE player_id = $1 AND batted = true AND runs_scored = 0
      `, [player_id]);
      const ducks = ducksResult.rows[0].count;

      // Calculate thirties (30-49 runs)
      const thirtiesResult = await pool.query(`
        SELECT COUNT(*)::int as count FROM player_match_stats
        WHERE player_id = $1 AND batted = true AND runs_scored >= 30 AND runs_scored < 50
      `, [player_id]);
      const thirties = thirtiesResult.rows[0].count;

      // Calculate twenties (20-29 runs)
      const twentiesResult = await pool.query(`
        SELECT COUNT(*)::int as count FROM player_match_stats
        WHERE player_id = $1 AND batted = true AND runs_scored >= 20 AND runs_scored < 30
      `, [player_id]);
      const twenties = twentiesResult.rows[0].count;

      // Calculate maidens (maiden overs)
      const maidensResult = await pool.query(`
        SELECT COALESCE(SUM(maidens), 0)::int as count FROM player_match_stats
        WHERE player_id = $1 AND bowled = true
      `, [player_id]);
      const maidens = maidensResult.rows[0].count;

      // Calculate 2-wicket hauls
      const twoWktHaulsResult = await pool.query(`
        SELECT COUNT(*)::int as count FROM player_match_stats
        WHERE player_id = $1 AND wickets_taken = 2
      `, [player_id]);
      const twoWktHauls = twoWktHaulsResult.rows[0].count;

      // Calculate 3-wicket hauls
      const threeWktHaulsResult = await pool.query(`
        SELECT COUNT(*)::int as count FROM player_match_stats
        WHERE player_id = $1 AND wickets_taken = 3
      `, [player_id]);
      const threeWktHauls = threeWktHaulsResult.rows[0].count;

      // Calculate 4-wicket hauls
      const fourWktHaulsResult = await pool.query(`
        SELECT COUNT(*)::int as count FROM player_match_stats
        WHERE player_id = $1 AND wickets_taken = 4
      `, [player_id]);
      const fourWktHauls = fourWktHaulsResult.rows[0].count;

      // Update the row
      const result = await pool.query(`
        UPDATE player_career_stats
        SET ducks = $1,
            thirties = $2,
            twenties = $3,
            maidens = $4,
            two_wkt_hauls = $5,
            three_wkt_hauls = $6,
            four_wkt_hauls = $7,
            updated_at = now()
        WHERE player_id = $8 AND format_family = $9
      `, [ducks, thirties, twenties, maidens, twoWktHauls, threeWktHauls, fourWktHauls, player_id, format_family]);

      if (result.rowCount > 0) {
        updated++;
        console.log(`✓ ${player_id.slice(0, 8)}... (${format_family}): ducks=${ducks}, thirties=${thirties}, twenties=${twenties}, maidens=${maidens}, 2wkt=${twoWktHauls}, 3wkt=${threeWktHauls}, 4wkt=${fourWktHauls}`);
      }
    }

    if (!apply) {
      await pool.query('ROLLBACK');
      console.log(`\n✅ Dry-run complete: ${updated} rows would be updated`);
      console.log('⚠️  Run with --apply to actually write changes\n');
    } else {
      console.log(`\n✅ Backfill complete: ${updated} rows updated\n`);
    }

  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

backfillCareerStats();
