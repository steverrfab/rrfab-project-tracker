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


async function seedDemoIfNeeded() {
  if (!process.env.DATABASE_URL) return;
  const client = await pool.connect();
  try {
    const exists = (await client.query("SELECT 1 FROM projects WHERE job_number = 'D-100' LIMIT 1")).rowCount;
    if (exists) return;
    await client.query('BEGIN');
    const pr = await client.query(
      `INSERT INTO projects (job_number, name, customer, original_contract, cost, pm, status, drawing_status, award_date, fab_start_date, material_ordered, notes)
       VALUES ('D-100', 'DEMO - Riverside Plant Expansion', 'Demo / Walsh Group', 1250000, 980000, 'Joe Jenkins', 'In Fabrication', 'Approved', '2026-03-12', '2026-04-20', true, 'Sample project so you can explore the tracker. Safe to archive when you are done.')
       RETURNING id`);
    const id = pr.rows[0].id;
    const hist = [['Awarded', '2026-03-12'], ['Purchasing', '2026-04-01'], ['In Fabrication', '2026-04-20']];
    for (const [st, dt] of hist) await client.query('INSERT INTO stage_history (project_id, status, changed_at) VALUES ($1, $2, $3)', [id, st, dt + 'T12:00:00Z']);
    await client.query("INSERT INTO deliveries (project_id, delivery_date, description, done, done_at, sort_order) VALUES ($1, '2026-06-05', 'Sequence 1 - columns & base plates', true, now(), 0)", [id]);
    await client.query("INSERT INTO deliveries (project_id, delivery_date, description, done, sort_order) VALUES ($1, '2026-07-15', 'Sequence 2 - beams & bracing', false, 1)", [id]);
    await client.query("INSERT INTO change_orders (project_id, co_number, description, amount, status, submitted_date, approved_date) VALUES ($1, 'CO-01', 'Added equipment support steel', 48000, 'Approved', '2026-05-01', '2026-05-14')", [id]);
    await client.query("INSERT INTO change_orders (project_id, co_number, description, amount, status, submitted_date) VALUES ($1, 'CO-02', 'Revised handrail layout', 9500, 'Pending', '2026-06-10')", [id]);
    await client.query("INSERT INTO invoices (project_id, application_number, period_end, work_completed_to_date, retainage_pct, status, submitted_date, approved_date, paid_date, amount_paid) VALUES ($1, 1, '2026-04-30', 380000, 10, 'Paid', '2026-05-02', '2026-05-09', '2026-05-28', 342000)", [id]);
    await client.query("INSERT INTO invoices (project_id, application_number, period_end, work_completed_to_date, retainage_pct, status, submitted_date) VALUES ($1, 2, '2026-05-31', 720000, 10, 'Submitted', '2026-06-03')", [id]);
    await client.query('COMMIT');
    console.log('[seed] Demo project created.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[seed] failed:', err.message);
  } finally {
    client.release();
  }
}


async function runExtraMigrations() {
  if (!process.env.DATABASE_URL) return;
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS project_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      body text NOT NULL,
      created_by uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes (project_id)');
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS projected_start_date date');
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS completed_date date');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS status text');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS fab_date date');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS galv_out_date date');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS galv_back_date date');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS paint_date date');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS ship_date date');
    await client.query('ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS erect_date date');
    await client.query("UPDATE deliveries SET status = CASE WHEN done THEN 'Shipped' ELSE 'In Fabrication' END WHERE status IS NULL");
    await client.query('UPDATE deliveries SET ship_date = delivery_date WHERE ship_date IS NULL AND done = true');
    // Lifecycle now starts at Awarded; relax the status check and map old values.
    await client.query("UPDATE projects SET status = 'Awarded' WHERE status IN ('Bidding', 'Submitted')");
    await client.query("UPDATE projects SET status = 'On Hold' WHERE status = 'Lost/On Hold'");
    await client.query('ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check');
    await client.query("DELETE FROM stage_history WHERE status IN ('Bidding', 'Submitted')");
    await client.query("UPDATE stage_history SET status = 'On Hold' WHERE status = 'Lost/On Hold'");
    // Archive bookkeeping: remember when a job was archived and by whom.
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz');
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id)');
    // Bid tool integration: provenance for imported won jobs + no-duplicate guard.
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_estimate_id integer');
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_bid_number text');
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS imported_at timestamptz');
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_projects_job_number ON projects (job_number) WHERE job_number IS NOT NULL AND job_number <> ''");
    await client.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token text NOT NULL,
      expires_at timestamptz NOT NULL,
      used boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets (token)');
    // Who gets emailed when a new job lands in the tracker (managed in-app by admins).
    await client.query(`CREATE TABLE IF NOT EXISTS tracker_notification_recipients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT '',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now())`);
    // Retainage release apps + partial payments: new flag plus a relaxed
    // status check so 'Partially Paid' works on databases created earlier.
    await client.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_retainage_release boolean NOT NULL DEFAULT false');
    await client.query('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check');
    // Conflict guard: track when a project row last changed.
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()');
    // Setup flag: jobs imported from the bid tool arrive with no planning dates.
    // Flag them "needs setup" until someone fills in the projected start date.
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS needs_setup boolean NOT NULL DEFAULT false');
    // Backfill: flag existing imported jobs that still have no projected start
    // and are neither archived nor completed. Set-up jobs (projected start filled)
    // are skipped, so this stays a no-op on later restarts.
    await client.query("UPDATE projects SET needs_setup = true WHERE imported_at IS NOT NULL AND projected_start_date IS NULL AND is_archived = false AND status <> 'Completed'");
    // AIA progress billing: schedule of values per project + per-line G703 detail
    // on each pay app. Additive; existing single-number invoices keep working.
    await client.query(`CREATE TABLE IF NOT EXISTS sov_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_no text,
      description text,
      scheduled_value numeric(14,2) NOT NULL DEFAULT 0,
      retainage_pct numeric(5,2) NOT NULL DEFAULT 10,
      sort_order integer,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_sov_lines_project ON sov_lines (project_id)');
    await client.query(`CREATE TABLE IF NOT EXISTS invoice_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      sov_line_id uuid REFERENCES sov_lines(id),
      item_no text,
      description text,
      scheduled_value numeric(14,2) NOT NULL DEFAULT 0,
      percent_complete numeric(5,2) NOT NULL DEFAULT 0,
      from_previous numeric(14,2) NOT NULL DEFAULT 0,
      stored_materials numeric(14,2) NOT NULL DEFAULT 0,
      retainage_pct numeric(5,2) NOT NULL DEFAULT 10)`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id)');
    console.log('[migrate] Extra migrations applied (notes table, status lifecycle, archive columns, needs_setup flag, SOV + invoice lines).');
  } catch (err) {
    console.error('[migrate] extra migrations failed:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, runMigrations, runExtraMigrations, seedDemoIfNeeded };
