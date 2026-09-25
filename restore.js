// Load a nightly backup (rr-tracker-db-*.json.gz) into a Postgres database.
// See RESTORE.md for the full steps. Usage:
//   DATABASE_URL=postgres://... node restore.js rr-tracker-db-2026-09-25T07-00-00Z.json.gz --yes
//
// The target database should already have the tracker's tables: start the app
// once against it (it creates them), or run `node -e "require('./migrate').runMigrations().then(()=>require('./migrate').runExtraMigrations()).then(()=>process.exit())"`.
// Everything currently in those tables is replaced by the backup.

const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('pg');

const file = process.argv[2];
if (!file || !process.argv.includes('--yes')) {
  console.log('Usage: DATABASE_URL=postgres://... node restore.js <backup .json.gz> --yes');
  console.log('This REPLACES every table in that database with the backup. --yes confirms.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to the database to restore into.'); process.exit(1); }

const q = n => '"' + String(n).replace(/"/g, '""') + '"';

(async () => {
  const backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (backup.app !== 'rrfab-project-tracker') throw new Error('That file is not a tracker backup.');
  console.log('Backup taken ' + backup.created_at + ', ' + Object.keys(backup.tables).length + ' tables.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false });
  const client = await pool.connect();
  try {
    const have = new Set((await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map(r => r.table_name));
    const names = Object.keys(backup.tables).filter(n => {
      if (!have.has(n)) console.warn('  skipping ' + n + ': no such table in the target database');
      return have.has(n);
    });
    if (!names.length) throw new Error('None of the backup tables exist in the target. Start the app against it once first.');

    // Parents before children, so every row's links are already there.
    const fks = (await client.query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)).rows;
    const strip = s => s.replace(/^public\./, '').replace(/^"|"$/g, '');
    const order = [], seen = new Set();
    const visit = (n, path) => {
      if (seen.has(n) || path.has(n)) return;
      path.add(n);
      for (const f of fks) if (strip(f.child) === n && strip(f.parent) !== n && names.includes(strip(f.parent))) visit(strip(f.parent), path);
      seen.add(n); order.push(n);
    };
    names.forEach(n => visit(n, new Set()));

    await client.query('BEGIN');
    await client.query('TRUNCATE ' + order.map(q).join(', ') + ' CASCADE');
    for (const name of order) {
      const t = backup.tables[name];
      const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [name])).rows.map(r => r.column_name);
      const keep = t.columns.map((c, i) => [c, i]).filter(([c]) => cols.includes(c));
      t.columns.filter(c => !cols.includes(c)).forEach(c => console.warn('  ' + name + ': column ' + c + ' no longer exists, left out'));
      const per = Math.max(1, Math.floor(30000 / Math.max(1, keep.length)));
      for (let i = 0; i < t.rows.length; i += per) {
        const batch = t.rows.slice(i, i + per);
        const params = [], values = [];
        batch.forEach(row => {
          values.push('(' + keep.map(([, idx]) => { params.push(row[idx]); return '$' + params.length; }).join(', ') + ')');
        });
        await client.query('INSERT INTO ' + q(name) + ' (' + keep.map(([c]) => q(c)).join(', ') + ') VALUES ' + values.join(', '), params);
      }
      console.log('  ' + name + ': ' + t.rows.length + ' rows');
    }
    // Any auto-numbered columns carry on from the highest restored number.
    const seqs = (await client.query(`SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
      FROM information_schema.columns WHERE table_schema = 'public' AND pg_get_serial_sequence(quote_ident(table_name), column_name) IS NOT NULL`)).rows;
    for (const s of seqs) {
      if (!order.includes(s.table_name)) continue;
      await client.query(`SELECT setval($1, COALESCE((SELECT MAX(${q(s.column_name)}) FROM ${q(s.table_name)}), 0) + 1, false)`, [s.seq]);
    }
    await client.query('COMMIT');
    console.log('Restore finished.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(e => { console.error('Restore FAILED, nothing was changed: ' + e.message); process.exit(1); });
