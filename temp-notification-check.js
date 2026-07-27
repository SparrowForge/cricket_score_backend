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
    const notif = (await pool.query("SELECT count(*) AS count FROM notifications WHERE event_type='match.result' OR event_type='match.complete' OR event_type LIKE 'match.%' ")).rows[0];
    const follows = (await pool.query("SELECT entity_type, count(*) FROM user_follows GROUP BY entity_type")).rows;
    const devices = (await pool.query('SELECT count(*) AS count FROM user_devices')).rows[0];
    const users = (await pool.query('SELECT count(*) AS count FROM users')).rows[0];
    const sample = (await pool.query("SELECT id, user_id, event_type, title, body, data, sent_at, read_at, created_at FROM notifications WHERE event_type='match.result' ORDER BY created_at DESC LIMIT 5")).rows;
    console.log('notifications by type count:', notif);
    console.log('user_follows counts:', JSON.stringify(follows));
    console.log('user_devices count:', devices);
    console.log('users count:', users);
    console.log('sample match.result notifications:', JSON.stringify(sample, null, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
