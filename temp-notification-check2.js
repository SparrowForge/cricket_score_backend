const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    const follows = (await pool.query("SELECT entity_type, entity_id, count(*) AS cnt FROM user_follows GROUP BY entity_type, entity_id ORDER BY cnt DESC LIMIT 20")).rows;
    const followTournaments = (await pool.query("SELECT t.id, t.name, t.slug FROM tournaments t WHERE t.id IN (SELECT entity_id FROM user_follows WHERE entity_type='tournament') LIMIT 10")).rows;
    const followTeams = (await pool.query("SELECT tm.id, tm.name, tm.short_name FROM teams tm WHERE tm.id IN (SELECT entity_id FROM user_follows WHERE entity_type='team') LIMIT 10")).rows;
    const notifications = (await pool.query("SELECT id,user_id,event_type,title,body,data,sent_at,read_at,created_at FROM notifications WHERE event_type='match.result' ORDER BY created_at DESC LIMIT 10")).rows;
    const deviceCount = (await pool.query('SELECT count(*) AS cnt FROM user_devices')).rows[0];
    const prefs = (await pool.query('SELECT count(*) AS cnt FROM notification_preferences')).rows[0];
    console.log('follows sample:', JSON.stringify(follows, null, 2));
    console.log('following tournaments:', JSON.stringify(followTournaments, null, 2));
    console.log('following teams:', JSON.stringify(followTeams, null, 2));
    console.log('device count:', deviceCount);
    console.log('notification_preferences count:', prefs);
    console.log('sample match.result notifications:', JSON.stringify(notifications, null, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
