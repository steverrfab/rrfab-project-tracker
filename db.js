const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'projects.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    job_number TEXT,
    name TEXT NOT NULL,
    customer TEXT,
    sell_price REAL,
    cost REAL,
    status TEXT DEFAULT 'Bidding',
    bid_due_date TEXT,
    submitted_date TEXT,
    award_date TEXT,
    project_start_date TEXT,
    fab_start_date TEXT,
    galv_send_date TEXT,
    galv_return_date TEXT,
    paint_send_date TEXT,
    paint_complete_date TEXT,
    material_ordered INTEGER DEFAULT 0,
    pm TEXT,
    drawing_status TEXT DEFAULT 'N/A',
    change_orders INTEGER DEFAULT 0,
    delivery_date TEXT,
    deliveries TEXT DEFAULT '[]',
    notes TEXT,
    created_at TEXT
  )
`);

module.exports = db;
