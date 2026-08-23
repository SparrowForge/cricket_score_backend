const fs=require('fs');
for (const l of fs.readFileSync(__dirname+'/.env','utf8').split(/\r?\n/)) {
  const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if(m&&!(m[1] in process.env)) process.env[m[1]]=m[2];
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
pool.query(fs.readFileSync(process.argv[2],'utf8')).then(r=>console.table(r.rows)).catch(e=>console.error('ERR',e.message)).finally(()=>pool.end());
