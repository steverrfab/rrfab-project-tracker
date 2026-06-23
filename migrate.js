// PostgreSQL connection + one-time schema creation.
// Runs on server startup. Safe to run repeatedly: it only creates the
// tables if they are not already there.

const { Pool } = require('pg');
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

module.exports = { pool, runMigrations };
