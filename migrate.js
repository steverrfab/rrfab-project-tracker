// PostgreSQL connection + one-time schema creation.
// Runs on server startup. Safe to run repeatedly: it only creates the
// tables if they are not already there.

const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // DATE -> 'YYYY-MM-DD' string (no timezone shift)
const fs = require('fs');
const path = require('path');

// Railway provides DATABASE_URL when this service is linked to the Postgres
// service. Internal connections do not use SSL; set PGSSL=require only if you
// ever connect over the public URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.warn('[migrate] DATABASE_URL is not set; skipping Postgres setup.');
    return;
  }
  const client = await pool.connect();
  try {
    const check = await client.query("SELECT to_regclass('public.users') AS t");
    if (check.rows[0].t) {
      console.log('[migrate] Tables already exist; nothing to create.');
      return;
    }
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('[migrate] Schema applied: created users, projects, stage_history, deliveries, change_orders, invoices, documents.');
  } finally {
    client.release();
  }
}


const DEMO_MARKER = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || './data', 'demo_seeded');
async function seedDemoIfNeeded() {
  if (!process.env.DATABASE_URL) return;
  try { if (fs.existsSync(DEMO_MARKER)) return; } catch (_) {}
  const client = await pool.connect();
  try {
    const n = (await client.query('SELECT count(*)::int AS n FROM projects')).rows[0].n;
    if (n === 0) {
      await client.query('BEGIN');
      const pr = await client.query(
        `INSERT INTO projects (job_number, name, customer, original_contract, cost, pm, status, drawing_status, award_date, fab_start_date, material_ordered, notes)
         VALUES ('D-100', 'DEMO - Riverside Plant Expansion', 'Demo / Walsh Group', 1250000, 980000, 'Joe Jenkins', 'In Fabrication', 'Approved', '2026-03-12', '2026-04-20', true, 'Sample project so you can explore the tracker. Safe to archive when you are done.')
         RETURNING id`);
      const id = pr.rows[0].id;
      const hist = [['Bidding', '2026-01-15'], ['Submitted', '2026-02-02'], ['Awarded', '2026-03-12'], ['Purchasing', '2026-04-01'], ['In Fabrication', '2026-04-20']];
      for (const [st, dt] of hist) await client.query('INSERT INTO stage_history (project_id, status, changed_at) VALUES ($1, $2, $3)', [id, st, dt + 'T12:00:00Z']);
      await client.query("INSERT INTO deliveries (project_id, delivery_date, description, done, done_at, sort_order) VALUES ($1, '2026-06-05', 'Sequence 1 - columns & base plates', true, now(), 0)", [id]);
      await client.query("INSERT INTO deliveries (project_id, delivery_date, description, done, sort_order) VALUES ($1, '2026-07-15', 'Sequence 2 - beams & bracing', false, 1)", [id]);
      await client.query("INSERT INTO change_orders (project_id, co_number, description, amount, status, submitted_date, approved_date) VALUES ($1, 'CO-01', 'Added equipment support steel', 48000, 'Approved', '2026-05-01', '2026-05-14')", [id]);
      await client.query("INSERT INTO change_orders (project_id, co_number, description, amount, status, submitted_date) VALUES ($1, 'CO-02', 'Revised handrail layout', 9500, 'Pending', '2026-06-10')", [id]);
      await client.query("INSERT INTO invoices (project_id, application_number, period_end, work_completed_to_date, retainage_pct, status, submitted_date, approved_date, paid_date, amount_paid) VALUES ($1, 1, '2026-04-30', 380000, 10, 'Paid', '2026-05-02', '2026-05-09', '2026-05-28', 342000)", [id]);
      await client.query("INSERT INTO invoices (project_id, application_number, period_end, work_completed_to_date, retainage_pct, status, submitted_date) VALUES ($1, 2, '2026-05-31', 720000, 10, 'Submitted', '2026-06-03')", [id]);
      await client.query('COMMIT');
      console.log('[seed] Demo project created.');
    }
    try { fs.writeFileSync(DEMO_MARKER, new Date().toISOString()); } catch (_) {}
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[seed] failed:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, runMigrations, seedDemoIfNeeded };
