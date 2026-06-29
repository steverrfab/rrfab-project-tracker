const express = require('express');
const path = require('path');
const { pool, runMigrations, runExtraMigrations, seedDemoIfNeeded } = require('./migrate');
const auth = require('./auth');
const mailer = require('./mailer');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// ====== AUTH (public) ======
app.get('/api/auth/status', async (req, res) => {
  try {
    const n = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const u = auth.getUserFromReq(req);
    res.json({ hasUsers: n > 0, authenticated: !!u, user: u ? { id: u.id, name: u.name, role: u.role } : null });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/auth/setup', async (req, res) => {
  try {
    const n = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role='super_admin'")).rows[0].n;
    if (n > 0) return res.status(400).json({ error: 'Already set up' });
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'super_admin') RETURNING id, name, role",
      [name, String(email).toLowerCase(), auth.hashPassword(password)]);
    auth.setAuthCookie(res, rows[0]);
    res.json({ ok: true, user: { id: rows[0].id, name: rows[0].name, role: rows[0].role } });
  } catch (err) { console.error(err); res.status(500).json({ error: err.code === '23505' ? 'That email is already registered' : err.message }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
    const u = rows[0];
    if (!u || !u.is_active || !auth.verifyPassword(password || '', u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    auth.setAuthCookie(res, u);
    res.json({ ok: true, user: { id: u.id, name: u.name, role: u.role } });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/auth/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

// Forgot password: email a reset link. Generic response so it never reveals
// which emails exist (except a clear message if email is not set up at all).
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Enter your email.' });
  try {
    const u = (await pool.query('SELECT id, name, email, is_active FROM users WHERE email = $1', [email])).rows[0];
    if (u && u.is_active) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query('INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)', [u.id, token, expires]);
      const base = (process.env.PUBLIC_URL || ((req.get('x-forwarded-proto') || 'https') + '://' + req.get('host'))).replace(/\/+$/, '');
      const link = base + '/reset?token=' + token;
      try {
        await mailer.sendMail({
          to: u.email,
          subject: 'Reset your R&R Project Tracker password',
          html: '<p>Hi ' + (u.name || '') + ',</p><p>Click the link below to set a new password. It expires in 1 hour.</p><p><a href="' + link + '">' + link + '</a></p><p>If you did not request this, you can ignore this email.</p>',
          text: 'Reset your password (expires in 1 hour): ' + link,
        });
      } catch (e) {
        console.error('[forgot] email failed:', e.message);
        if (!mailer.isConfigured()) return res.status(503).json({ error: 'Email is not set up on the server yet. Ask an admin to reset your password from Settings.' });
        return res.status(502).json({ error: 'Could not send the reset email right now. Try again later, or ask an admin to reset it.' });
      }
    } else if (!mailer.isConfigured()) {
      return res.status(503).json({ error: 'Email is not set up on the server yet. Ask an admin to reset your password from Settings.' });
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Reset password using the emailed token.
app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const np = String(req.body.newPassword || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing reset token.' });
  if (np.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const row = (await pool.query('SELECT * FROM password_resets WHERE token = $1', [token])).rows[0];
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [auth.hashPassword(np), row.user_id]);
    await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [row.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Everything else under /api requires a logged-in user.
app.use('/api', auth.requireAuth);

// ====== USERS (admins) ======
const userToClient = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.is_active });
app.get('/api/users', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at'); res.json(rows.map(userToClient)); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/users', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!['admin', 'accounting', 'pm', 'shop'].includes(role)) return res.status(400).json({ error: 'Pick a role (Admin, Accounting, PM, or Shop)' });
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and a temporary password are required' });
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, String(email).toLowerCase(), auth.hashPassword(password), role]);
    res.json(userToClient(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.code === '23505' ? 'That email is already registered' : err.message }); }
});
app.put('/api/users/:id', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const target = (await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ error: 'Not found' });
    if (target.role === 'super_admin' && req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only the Super Admin can change that account' });
    const { name, role, active, password } = req.body;
    const newRole = target.role === 'super_admin' ? 'super_admin' : (['admin', 'accounting', 'pm', 'shop'].includes(role) ? role : target.role);
    await pool.query(
      'UPDATE users SET name = COALESCE($1, name), role = $2, is_active = $3, password_hash = COALESCE($4, password_hash) WHERE id = $5',
      [name || null, newRole, active != null ? !!active : target.is_active, password ? auth.hashPassword(password) : null, req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


// helpers
const d = v => (v === undefined || v === null || v === '') ? null : v;
const money = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

// shape a DB row (+ its deliveries) into what the existing frontend expects
function toClient(p, deliveries) {
  return {
    id: p.id,
    jobNumber: p.job_number || '',
    name: p.name,
    customer: p.customer || '',
    sellPrice: p.original_contract,
    cost: p.cost,
    status: p.status,
    bidDueDate: p.bid_due_date || '',
    submittedDate: p.submitted_date || '',
    awardDate: p.award_date || '',
    projectStartDate: p.project_start_date || '',
    fabStartDate: p.fab_start_date || '',
    galvSendDate: p.galv_send_date || '',
    galvReturnDate: p.galv_return_date || '',
    paintSendDate: p.paint_send_date || '',
    paintCompleteDate: p.paint_complete_date || '',
    materialOrdered: !!p.material_ordered,
    pm: p.pm || '',
    drawingStatus: p.drawing_status || 'N/A',
    changeOrders: Number(p.change_orders_count) || 0,
    deliveryDate: '',
    deliveries: (deliveries || []).map(x => ({
      id: x.id, date: (x.ship_date || x.delivery_date) || '', desc: x.description || '', done: !!x.done,
      status: x.status || '', fabDate: x.fab_date || '', galvOut: x.galv_out_date || '', galvBack: x.galv_back_date || '',
      paintDate: x.paint_date || '', shipDate: (x.ship_date || x.delivery_date) || '', erectDate: x.erect_date || '',
    })),
    notes: p.notes || '',
    createdAt: p.created_at ? new Date(p.created_at).toISOString() : '',
    projectedStartDate: p.projected_start_date || '',
    completedDate: p.completed_date || '',
  };
}

function projectValues(p) {
  return [
    d(p.jobNumber), p.name, d(p.customer), money(p.sellPrice), money(p.cost), d(p.pm),
    p.status || 'Bidding', p.drawingStatus || 'N/A',
    d(p.bidDueDate), d(p.submittedDate), d(p.awardDate), d(p.projectStartDate),
    d(p.fabStartDate), d(p.galvSendDate), d(p.galvReturnDate), d(p.paintSendDate),
    d(p.paintCompleteDate), p.materialOrdered ? true : false, d(p.notes),
  ];
}

async function replaceDeliveries(client, projectId, deliveries) {
  await client.query('DELETE FROM deliveries WHERE project_id = $1', [projectId]);
  let i = 0;
  for (const dv of (deliveries || [])) {
    await client.query(
      `INSERT INTO deliveries (project_id, delivery_date, description, done, done_at, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, d(dv.date), d(dv.desc), !!dv.done, dv.done ? new Date() : null, i++]
    );
  }
}

// GET all (non-archived)
app.get('/api/projects', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
         (SELECT count(*) FROM change_orders c WHERE c.project_id = p.id) AS change_orders_count
       FROM projects p
       WHERE p.is_archived = false
       ORDER BY p.created_at DESC`
    );
    const ids = rows.map(r => r.id);
    const delByProj = {};
    if (ids.length) {
      const dq = await pool.query(
        `SELECT * FROM deliveries WHERE project_id = ANY($1::uuid[])
         ORDER BY sort_order NULLS LAST, delivery_date NULLS LAST`,
        [ids]
      );
      for (const dv of dq.rows) {
        (delByProj[dv.project_id] = delByProj[dv.project_id] || []).push(dv);
      }
    }
    res.json(rows.map(p => toClient(p, delByProj[p.id])));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST new project (DB generates the uuid; client id is ignored)
app.post('/api/projects', auth.requireRole('super_admin', 'admin', 'pm'), async (req, res) => {
  const p = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO projects (
         job_number, name, customer, original_contract, cost, pm, status, drawing_status,
         bid_due_date, submitted_date, award_date, project_start_date, fab_start_date,
         galv_send_date, galv_return_date, paint_send_date, paint_complete_date,
         material_ordered, notes, projected_start_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id, status`,
      [...projectValues(p), d(p.projectedStartDate), req.user.id]
    );
    const id = ins.rows[0].id;
    await client.query(
      'INSERT INTO stage_history (project_id, status, changed_by) VALUES ($1, $2, $3)',
      [id, ins.rows[0].status, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT update project (records stage history when status changes)
app.put('/api/projects/:id', auth.requireRole('super_admin', 'admin', 'pm'), async (req, res) => {
  const p = req.body;
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT status FROM projects WHERE id = $1', [id]);
    if (prev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }
    await client.query(
      `UPDATE projects SET
         job_number=$1, name=$2, customer=$3, original_contract=$4, cost=$5, pm=$6, status=$7,
         drawing_status=$8, bid_due_date=$9, submitted_date=$10, award_date=$11,
         project_start_date=$12, fab_start_date=$13, galv_send_date=$14, galv_return_date=$15,
         paint_send_date=$16, paint_complete_date=$17, material_ordered=$18, notes=$19,
         projected_start_date=$20
       WHERE id=$21`,
      [...projectValues(p), d(p.projectedStartDate), id]
    );
    if (p.status === 'Completed') await client.query('UPDATE projects SET completed_date = COALESCE(completed_date, CURRENT_DATE) WHERE id = $1', [id]);
    if (prev.rows[0].status !== p.status) {
      await client.query(
        'INSERT INTO stage_history (project_id, status, changed_by) VALUES ($1, $2, $3)',
        [id, p.status, req.user.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// LIST archived projects (admins only). Includes small counts so the
// "permanently delete" screen can warn how much billing goes with the job.
app.get('/api/projects/archived', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.job_number, p.name, p.customer, p.status, p.original_contract,
              p.archived_at, u.name AS archived_by_name,
              (SELECT count(*) FROM invoices i WHERE i.project_id = p.id)      AS invoice_count,
              (SELECT count(*) FROM change_orders c WHERE c.project_id = p.id) AS co_count
         FROM projects p
         LEFT JOIN users u ON u.id = p.archived_by
        WHERE p.is_archived = true
        ORDER BY p.archived_at DESC NULLS LAST, p.created_at DESC`
    );
    res.json(rows.map(r => ({
      id: r.id, jobNumber: r.job_number || '', name: r.name, customer: r.customer || '',
      status: r.status, contract: r.original_contract,
      archivedAt: r.archived_at, archivedBy: r.archived_by_name || '',
      invoiceCount: Number(r.invoice_count) || 0, coCount: Number(r.co_count) || 0,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE = archive (keep the record, just hide it). Admins only.
app.delete('/api/projects/:id', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE projects SET is_archived = true, archived_at = now(), archived_by = $2 WHERE id = $1',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// RESTORE an archived project back to the active list. Admins only.
app.post('/api/projects/:id/restore', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE projects SET is_archived = false, archived_at = NULL, archived_by = NULL WHERE id = $1',
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PERMANENTLY delete a project and everything attached to it (pay apps,
// change orders, stage history, deliveries, documents all cascade). This
// truly erases the row and cannot be undone, so it is admins only and only
// works on a job that has already been archived.
app.delete('/api/projects/:id/permanent', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const chk = await pool.query('SELECT is_archived FROM projects WHERE id = $1', [req.params.id]);
    if (chk.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
    if (!chk.rows[0].is_archived) return res.status(400).json({ error: 'Archive the job first, then permanently delete it.' });
    await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// ====== file uploads (stored on the Railway volume) ======
const fs = require('fs');
const multer = require('multer');
const UPLOAD_DIR = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || './data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 30 * 1024 * 1024 } });

const NET_DAYS = 30;

// running AIA math across a project's pay apps
function invoiceRows(rows) {
  const apps = [...rows].sort((a, b) => a.application_number - b.application_number);
  let prevELR = 0;
  return apps.map(a => {
    const completed = Number(a.work_completed_to_date || 0);
    const pct = Number(a.retainage_pct || 0);
    const ret = a.retainage_held != null ? Number(a.retainage_held) : completed * pct / 100;
    const elr = completed - ret;
    const due = elr - prevELR;
    prevELR = elr;
    return {
      id: a.id, applicationNumber: a.application_number, periodEnd: a.period_end || '',
      workCompletedToDate: completed, retainagePct: pct, retainageHeld: ret,
      earnedLessRetainage: elr, currentPaymentDue: due,
      amountPaid: a.amount_paid, status: a.status,
      submittedDate: a.submitted_date || '', approvedDate: a.approved_date || '', paidDate: a.paid_date || '',
      notes: a.notes || '',
    };
  });
}
const approvedCoTotal = co => co.filter(c => c.status === 'Approved' || c.status === 'Paid').reduce((s, c) => s + Number(c.amount || 0), 0);
const daysSince = ds => ds ? Math.round((Date.now() - new Date(ds + 'T00:00:00').getTime()) / 86400000) : 0;

// ====== STAGE HISTORY ======
app.get('/api/projects/:id/stage-history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sh.status, sh.changed_at, u.name AS changed_by_name
       FROM stage_history sh LEFT JOIN users u ON u.id = sh.changed_by
       WHERE sh.project_id = $1 ORDER BY sh.changed_at DESC`, [req.params.id]);
    res.json(rows.map(r => ({ status: r.status, changedAt: r.changed_at, changedBy: r.changed_by_name || '' })));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ====== CHANGE ORDERS ======
const coToClient = c => ({ id: c.id, coNumber: c.co_number, description: c.description || '', amount: Number(c.amount || 0), status: c.status, submittedDate: c.submitted_date || '', approvedDate: c.approved_date || '', paidDate: c.paid_date || '' });
app.get('/api/projects/:id/change-orders', async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM change_orders WHERE project_id = $1 ORDER BY co_number', [req.params.id]); res.json(rows.map(coToClient)); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/projects/:id/change-orders', auth.requireRole('super_admin', 'admin', 'accounting', 'pm'), async (req, res) => {
  const c = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO change_orders (project_id, co_number, description, amount, status, submitted_date, approved_date, paid_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, c.coNumber, d(c.description), money(c.amount) || 0, c.status || 'Pending', d(c.submittedDate), d(c.approvedDate), d(c.paidDate), req.user.id]);
    res.json(coToClient(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.put('/api/change-orders/:coId', auth.requireRole('super_admin', 'admin', 'accounting', 'pm'), async (req, res) => {
  const c = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE change_orders SET co_number=$1, description=$2, amount=$3, status=$4, submitted_date=$5, approved_date=$6, paid_date=$7 WHERE id=$8 RETURNING *`,
      [c.coNumber, d(c.description), money(c.amount) || 0, c.status || 'Pending', d(c.submittedDate), d(c.approvedDate), d(c.paidDate), req.params.coId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(coToClient(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.delete('/api/change-orders/:coId', auth.requireRole('super_admin', 'admin', 'accounting', 'pm'), async (req, res) => {
  try { await pool.query('DELETE FROM change_orders WHERE id = $1', [req.params.coId]); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ====== INVOICES / PAY APPS ======
app.get('/api/projects/:id/invoices', async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM invoices WHERE project_id = $1', [req.params.id]); res.json(invoiceRows(rows)); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/projects/:id/invoices', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  const a = req.body;
  const held = (a.retainageHeld != null && a.retainageHeld !== '') ? money(a.retainageHeld) : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO invoices (project_id, application_number, period_end, work_completed_to_date, retainage_pct, retainage_held, status, submitted_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.params.id, parseInt(a.applicationNumber) || 1, d(a.periodEnd), money(a.workCompletedToDate) || 0, money(a.retainagePct) || 10, held, a.status || 'Draft', d(a.submittedDate), d(a.notes), req.user.id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.put('/api/invoices/:invId', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  const a = req.body;
  const held = (a.retainageHeld != null && a.retainageHeld !== '') ? money(a.retainageHeld) : null;
  try {
    const { rowCount } = await pool.query(
      `UPDATE invoices SET application_number=$1, period_end=$2, work_completed_to_date=$3, retainage_pct=$4, retainage_held=$5, status=$6, submitted_date=$7, approved_date=$8, notes=$9 WHERE id=$10`,
      [parseInt(a.applicationNumber) || 1, d(a.periodEnd), money(a.workCompletedToDate) || 0, money(a.retainagePct) || 10, held, a.status || 'Draft', d(a.submittedDate), d(a.approvedDate), d(a.notes), req.params.invId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/invoices/:invId/payment', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  const p = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE invoices SET amount_paid=$1, paid_date=$2, status='Paid' WHERE id=$3`,
      [money(p.amountPaid) || 0, d(p.paidDate) || new Date().toISOString().slice(0, 10), req.params.invId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.delete('/api/invoices/:invId', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  try { await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.invId]); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ====== DOCUMENTS ======
const docToClient = f => ({ id: f.id, fileName: f.file_name, fileType: f.file_type || '', fileSize: Number(f.file_size || 0), category: f.category || 'general', changeOrderId: f.change_order_id, invoiceId: f.invoice_id, uploadedAt: f.uploaded_at, uploadedBy: f.uploaded_by_name || '' });
app.get('/api/projects/:id/documents', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dn.*, u.name AS uploaded_by_name FROM documents dn LEFT JOIN users u ON u.id = dn.uploaded_by
       WHERE dn.project_id = $1 ORDER BY dn.uploaded_at DESC`, [req.params.id]);
    res.json(rows.map(docToClient));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/projects/:id/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { rows } = await pool.query(
      `INSERT INTO documents (project_id, change_order_id, invoice_id, file_name, file_type, file_size, storage_key, category, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, d(req.body.changeOrderId), d(req.body.invoiceId), req.file.originalname, req.file.mimetype, req.file.size, req.file.filename, d(req.body.category) || 'general', req.user.id]);
    res.json(docToClient(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.get('/api/documents/:docId/download', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [req.params.docId]);
    if (!rows.length) return res.status(404).send('Not found');
    res.download(path.join(UPLOAD_DIR, rows[0].storage_key), rows[0].file_name);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.delete('/api/documents/:docId', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING storage_key', [req.params.docId]);
    if (rows.length) { try { fs.unlinkSync(path.join(UPLOAD_DIR, rows[0].storage_key)); } catch (_) {} }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ====== BILLING / RECEIVABLES (company-wide) ======
app.get('/api/billing', async (req, res) => {
  try {
    const proj = (await pool.query('SELECT id, job_number, name, customer, original_contract, status FROM projects WHERE is_archived = false')).rows;
    const inv = (await pool.query('SELECT * FROM invoices')).rows;
    const cos = (await pool.query('SELECT * FROM change_orders')).rows;
    const invByProj = {}, coByProj = {};
    for (const i of inv) (invByProj[i.project_id] = invByProj[i.project_id] || []).push(i);
    for (const c of cos) (coByProj[c.project_id] = coByProj[c.project_id] || []).push(c);
    const ACTIVE_FAB = ['In Fabrication', 'Ready for Galvanizing/Paint', 'In Galvanizing', 'In Paint', 'Shipping', 'Field/Erection'];
    let billedToDate = 0, collected = 0, retainageHeld = 0;
    const open = [], paidHist = [], needsBilling = [];
    for (const p of proj) {
      const rows = invoiceRows(invByProj[p.id] || []);
      const last = rows[rows.length - 1];
      const contractSum = Number(p.original_contract || 0) + approvedCoTotal(coByProj[p.id] || []);
      const pBilled = last ? last.workCompletedToDate : 0;
      const pRet = last ? last.retainageHeld : 0;
      const pPaid = (invByProj[p.id] || []).reduce((s, i) => s + Number(i.amount_paid || 0), 0);
      billedToDate += pBilled; retainageHeld += pRet; collected += pPaid;
      for (const a of rows) {
        if (a.status === 'Submitted' || a.status === 'Approved') {
          const days = daysSince(a.submittedDate);
          open.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', applicationNumber: a.applicationNumber, submittedDate: a.submittedDate, days, overdue: days > NET_DAYS, due: a.currentPaymentDue, status: a.status });
        }
        if (a.status === 'Paid' && a.amountPaid) paidHist.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', applicationNumber: a.applicationNumber, paidDate: a.paidDate, amountPaid: Number(a.amountPaid) });
      }
      if (ACTIVE_FAB.includes(p.status)) {
        const unbilled = contractSum - pBilled;
        if (unbilled > 0) needsBilling.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', status: p.status, unbilled, lastBilled: last ? last.periodEnd : null });
      }
    }
    open.sort((a, b) => b.days - a.days); needsBilling.sort((a, b) => b.unbilled - a.unbilled); paidHist.sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));
    const outstanding = open.reduce((s, o) => s + o.due, 0);
    const overdue = open.filter(o => o.overdue).reduce((s, o) => s + o.due, 0);
    res.json({ billedToDate, collected, outstanding, overdue, retainageHeld, netDays: NET_DAYS, open, paidHist, needsBilling });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


// ====== PROJECT NOTES (running log) ======
app.get('/api/projects/:id/notes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.body, n.created_at, u.name AS author
       FROM project_notes n LEFT JOIN users u ON u.id = n.created_by
       WHERE n.project_id = $1 ORDER BY n.created_at DESC`, [req.params.id]);
    res.json(rows.map(r => ({ id: r.id, body: r.body, createdAt: r.created_at, author: r.author || '' })));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/projects/:id/notes', async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note is empty' });
  try {
    const { rows } = await pool.query('INSERT INTO project_notes (project_id, body, created_by) VALUES ($1, $2, $3) RETURNING id', [req.params.id, body, req.user.id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ====== SEQUENCES (per-job, each with its own milestone dates) ======
const SEQ_DONE = st => st === 'Shipped' || st === 'Erected';
const seqToClient = q => ({ id: q.id, description: q.description || '', status: q.status || 'Not started', done: !!q.done, fabDate: q.fab_date || '', galvOut: q.galv_out_date || '', galvBack: q.galv_back_date || '', paintDate: q.paint_date || '', shipDate: q.ship_date || '', erectDate: q.erect_date || '', sortOrder: q.sort_order });
app.get('/api/projects/:id/sequences', async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM deliveries WHERE project_id = $1 ORDER BY sort_order NULLS LAST, ship_date NULLS LAST', [req.params.id]); res.json(rows.map(seqToClient)); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post('/api/projects/:id/sequences', auth.requireRole('super_admin', 'admin', 'pm', 'shop'), async (req, res) => {
  const q = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO deliveries (project_id, description, status, done, fab_date, galv_out_date, galv_back_date, paint_date, ship_date, erect_date, delivery_date, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11) RETURNING *`,
      [req.params.id, d(q.description), q.status || 'Not started', SEQ_DONE(q.status), d(q.fabDate), d(q.galvOut), d(q.galvBack), d(q.paintDate), d(q.shipDate), d(q.erectDate), parseInt(q.sortOrder) || 0]);
    res.json(seqToClient(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.put('/api/sequences/:seqId', auth.requireRole('super_admin', 'admin', 'pm', 'shop'), async (req, res) => {
  const q = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE deliveries SET description=$1, status=$2, done=$3, fab_date=$4, galv_out_date=$5, galv_back_date=$6, paint_date=$7, ship_date=$8, delivery_date=$8, erect_date=$9 WHERE id=$10`,
      [d(q.description), q.status || 'Not started', SEQ_DONE(q.status), d(q.fabDate), d(q.galvOut), d(q.galvBack), d(q.paintDate), d(q.shipDate), d(q.erectDate), req.params.seqId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.delete('/api/sequences/:seqId', auth.requireRole('super_admin', 'admin', 'pm', 'shop'), async (req, res) => {
  try { await pool.query('DELETE FROM deliveries WHERE id = $1', [req.params.seqId]); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ====== IMPORT WON JOBS FROM THE BID TOOL (Step 3) ======
// Admin-only. Pulls the bid tool's won-jobs feed and creates a project for any
// job number not already in the tracker. Idempotent: existing job numbers skip.
app.post('/api/import/won-jobs', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  const base = process.env.BID_API_URL;
  const key = process.env.TRACKER_KEY;
  if (!base || !key) return res.status(500).json({ error: 'Bid integration is not configured (BID_API_URL / TRACKER_KEY).' });
  const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
  let feed;
  try {
    const r = await fetch(baseUrl + '/api/estimates/feed/won-jobs', { headers: { 'X-Integration-Key': key } });
    if (!r.ok) return res.status(502).json({ error: 'Bid tool refused the request (status ' + r.status + ').' });
    feed = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach the bid tool: ' + err.message });
  }
  const jobs = (feed && feed.jobs) || [];
  const client = await pool.connect();
  const imported = [], skipped = [];
  try {
    await client.query('BEGIN');
    for (const j of jobs) {
      const jobNo = String(j.job_number || '').trim();
      if (!jobNo) continue;
      const exists = await client.query('SELECT 1 FROM projects WHERE job_number = $1 LIMIT 1', [jobNo]);
      if (exists.rowCount) { skipped.push(jobNo); continue; }
      const ins = await client.query(
        'INSERT INTO projects (job_number, name, customer, original_contract, status, award_date, source_estimate_id, source_bid_number, imported_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) RETURNING id',
        [jobNo, j.project_name || ('Job ' + jobNo), d(j.client_gc), money(j.contract_amount), 'Awarded', d(String(j.won_at || '').slice(0, 10)), j.estimate_id || null, d(j.bid_number), req.user.id]);
      await client.query('INSERT INTO stage_history (project_id, status, changed_by) VALUES ($1, $2, $3)', [ins.rows[0].id, 'Awarded', req.user.id]);
      imported.push(jobNo);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
  res.json({ ok: true, importedCount: imported.length, skippedCount: skipped.length, imported, skipped });
});

// ====== ADMIN "IMPORT WON JOBS" PAGE (Step 4) ======
// Lightweight standalone page so the import is one click. Visit /admin/import
// while logged in as an admin. The POST it calls is admin-protected above.
app.get('/admin/import', (req, res) => {
  res.type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Import won jobs - R&R Project Tracker</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f6f9;color:#1c2430;margin:0;padding:40px;display:flex;justify-content:center}' +
    '.card{background:#fff;border:1px solid #e2e7ee;border-radius:14px;padding:28px;max-width:560px;width:100%}' +
    'h1{font-size:20px;margin:0 0 4px}p.sub{color:#6b7889;font-size:13px;margin:0 0 20px}' +
    'button{background:#d98521;color:#3a2400;border:0;border-radius:9px;padding:12px 18px;font-size:15px;font-weight:700;cursor:pointer}' +
    'button:disabled{opacity:.5;cursor:not-allowed}' +
    '#out{margin-top:18px;font-size:14px;white-space:pre-wrap;line-height:1.5}' +
    'a{color:#2f6fb0}</style></head><body><div class="card">' +
    '<h1>Import won jobs</h1>' +
    '<p class="sub">Pulls every won bid (with a job number) from R&R Bid and adds any new ones to the tracker at the Awarded stage. Running it again is safe; jobs already here are skipped.</p>' +
    '<button id="b">Import won jobs</button><div id="out"></div>' +
    '<p style="margin-top:22px"><a href="/">Back to the tracker</a></p>' +
    '<script>' +
    'var b=document.getElementById("b"),out=document.getElementById("out");' +
    'b.onclick=async function(){b.disabled=true;out.textContent="Working...";' +
    'try{var r=await fetch("/api/import/won-jobs",{method:"POST"});var j=await r.json();' +
    'if(!r.ok){out.textContent=(r.status===401?"Please log in as an admin first, then reload this page.":(r.status===403?"You need an admin account to import.":("Error: "+(j.error||r.status))));b.disabled=false;return;}' +
    'out.textContent="Imported "+j.importedCount+" job(s)"+(j.imported.length?": "+j.imported.join(", "):"")+".\\nSkipped "+j.skippedCount+" already in the tracker"+(j.skipped.length?": "+j.skipped.join(", "):"")+".";' +
    'b.disabled=false;}catch(e){out.textContent="Could not reach the server: "+e.message;b.disabled=false;}};' +
    '</script></div></body></html>'
  );
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
});

// Create the PostgreSQL tables on startup (non-fatal if it cannot connect).
// Demo seeding is intentionally turned off: real data only from here on.
runMigrations().then(() => runExtraMigrations()).catch(err => console.error('[startup] failed:', err.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`R&R Project Tracker running on port ${PORT}`));
