const express = require('express');
const path = require('path');
const { pool, runMigrations, runExtraMigrations, seedDemoIfNeeded } = require('./migrate');
const auth = require('./auth');
const mailer = require('./mailer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// Roles allowed to see money. Shop is excluded from all financials.
const FINANCIAL_ROLES = ['super_admin', 'admin', 'accounting', 'pm'];
const requireFinancial = auth.requireRole(...FINANCIAL_ROLES);

// Allowed values for server-side validation (mirrors the frontend lists).
const PROJECT_STATUSES = ['Awarded', 'Detailing', 'Purchasing', 'In Fabrication', 'Ready for Galvanizing/Paint', 'In Galvanizing', 'In Paint', 'Shipping', 'Field/Erection', 'Completed', 'On Hold'];
const DRAWING_STATUSES = ['N/A', 'Not Started', 'In Progress', 'Approved', 'Revision Needed'];
const SEQUENCE_STATUSES = ['Not started', 'In Fabrication', 'In Galvanizing', 'In Paint', 'Shipped', 'Erected'];
const ACTIVE_STAGES = ['Detailing', 'Purchasing', 'In Fabrication', 'Ready for Galvanizing/Paint', 'In Galvanizing', 'In Paint', 'Shipping', 'Field/Erection'];

// Never send raw error details to the client; log them here instead.
function serverError(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}

// Escape values that get interpolated into email HTML.
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Constant-time comparison for shared secrets (hash first so lengths match).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const sha256Hex = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// Simple in-memory rate limiter: max 10 attempts per 15 minutes per IP+email.
const RATE_MAX = 10, RATE_WINDOW_MS = 15 * 60 * 1000;
const rateBuckets = new Map();
function rateLimited(req) {
  const email = String((req.body || {}).email || '').toLowerCase();
  const key = (req.ip || (req.socket && req.socket.remoteAddress) || '') + '|' + email;
  const now = Date.now();
  if (rateBuckets.size > 5000) { for (const [k, b] of rateBuckets) { if (now - b.start > RATE_WINDOW_MS) rateBuckets.delete(k); } }
  const b = rateBuckets.get(key);
  if (!b || now - b.start > RATE_WINDOW_MS) { rateBuckets.set(key, { start: now, count: 1 }); return false; }
  b.count += 1;
  return b.count > RATE_MAX;
}

// ====== HEALTH CHECK (public) ======
app.get('/api/health', async (req, res) => {
  let db = 'down';
  try { await pool.query('SELECT 1'); db = 'up'; } catch (_) {}
  res.json({ ok: true, service: 'rrfab-project-tracker', db, time: new Date().toISOString() });
});

// ====== AUTH (public) ======
app.get('/api/auth/status', async (req, res) => {
  try {
    const n = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const u = auth.getUserFromReq(req);
    res.json({ hasUsers: n > 0, authenticated: !!u, user: u ? { id: u.id, name: u.name, role: u.role } : null });
  } catch (err) { serverError(res, err); }
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
  } catch (err) { if (err.code === '23505') return res.status(400).json({ error: 'That email is already registered' }); serverError(res, err); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    if (rateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
    const u = rows[0];
    // SSO-only mode: everyone signs in through R&R Bid except the Super Admin,
    // whose password login stays as the break-glass path.
    if (process.env.SSO_ONLY === '1' && (!u || u.role !== 'super_admin')) return res.status(403).json({ error: 'Please sign in through R&R Bid', ssoOnly: true });
    if (!u || !u.is_active || !auth.verifyPassword(password || '', u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    auth.setAuthCookie(res, u);
    res.json({ ok: true, user: { id: u.id, name: u.name, role: u.role } });
  } catch (err) { serverError(res, err); }
});
app.post('/api/auth/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

// Tells the login screen whether SSO-only mode is on and where R&R Bid lives.
app.get('/api/auth/mode', (req, res) => {
  res.json({ ssoOnly: process.env.SSO_ONLY === '1', bidUrl: process.env.BID_TOOL_URL || '' });
});

// Forgot password: email a reset link. Generic response so it never reveals
// which emails exist (except a clear message if email is not set up at all).
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Enter your email.' });
  if (rateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  try {
    const u = (await pool.query('SELECT id, name, email, is_active FROM users WHERE email = $1', [email])).rows[0];
    if (u && u.is_active) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      // Store only the sha256 of the token; the raw token goes in the email.
      await pool.query('INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)', [u.id, sha256Hex(token), expires]);
      const base = (process.env.PUBLIC_URL || ((req.get('x-forwarded-proto') || 'https') + '://' + req.get('host'))).replace(/\/+$/, '');
      const link = base + '/reset?token=' + token;
      try {
        await mailer.sendMail({
          to: u.email,
          subject: 'Reset your R&R Project Tracker password',
          html: '<p>Hi ' + escapeHtml(u.name || '') + ',</p><p>Click the link below to set a new password. It expires in 1 hour.</p><p><a href="' + link + '">' + link + '</a></p><p>If you did not request this, you can ignore this email.</p>',
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
  } catch (err) { serverError(res, err); }
});

// Reset password using the emailed token.
app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const np = String(req.body.newPassword || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing reset token.' });
  if (np.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const row = (await pool.query('SELECT * FROM password_resets WHERE token = $1', [sha256Hex(token)])).rows[0];
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [auth.hashPassword(np), row.user_id]);
    await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [row.id]);
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// ====== RECEIVE ONE WON JOB (real-time push from the bid tool) ======
// The bid tool calls this the instant a bid is marked Won with a job number.
// Protected by the shared TRACKER_KEY (same secret as the pull feed), NOT a user
// login, so it is registered here ABOVE the /api login guard. Idempotent on
// job_number: a repeat call for a job already present changes nothing.
app.post('/api/integration/won-job', async (req, res) => {
  const key = process.env.TRACKER_KEY || '';
  const provided = req.get('X-Integration-Key') || '';
  if (!key || !provided || !safeEqual(provided, key)) return res.status(401).json({ error: 'invalid integration key' });
  const j = req.body || {};
  const jobNo = String(j.job_number || '').trim();
  if (!jobNo) return res.status(400).json({ error: 'job_number is required' });
  const client = await pool.connect();
  let newId;
  try {
    newId = await createProjectFromWonJob(client, j, null);
  } catch (err) {
    console.error('[won-job] failed:', err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  } finally {
    client.release();
  }
  if (!newId) return res.json({ ok: true, created: false, job_number: jobNo, message: 'already in the tracker' });
  notifyNewProject({ id: newId, job_number: jobNo, name: j.project_name || ('Job ' + jobNo), customer: j.client_gc, contract_amount: j.contract_amount })
    .catch(e => console.error('[notify] failed:', e.message));
  res.json({ ok: true, created: true, job_number: jobNo, project_id: newId });
});

// ====== SSO FROM THE BID TOOL (public; mounted before the auth wall) ======
// R&R Bid signs a short-lived JWT with the shared TRACKER_KEY and sends the
// user here. We verify it, create or update the matching tracker user, set
// the normal session cookie, and land them on the app. Verification failures
// get a plain page that never echoes the token or the reason.
const SSO_ROLES = ['admin', 'accounting', 'pm', 'shop'];
function ssoErrorPage(res, msg) {
  res.status(400).type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Sign-in problem - R&R Project Tracker</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f6f9;color:#1c2430;margin:0;padding:40px;display:flex;justify-content:center}' +
    '.card{background:#fff;border:1px solid #e2e7ee;border-radius:14px;padding:28px;max-width:460px;width:100%}' +
    'h1{font-size:18px;margin:0 0 8px}p{color:#6b7889;font-size:14px;line-height:1.6;margin:0}</style></head>' +
    '<body><div class="card"><h1>Could not sign you in</h1><p>' + msg + '</p></div></body></html>');
}
app.get('/sso', async (req, res) => {
  const invalidMsg = 'Sign-in link expired or invalid. Go back to R&R Bid and click Project Tracker again.';
  const token = String(req.query.token || '');
  const key = process.env.TRACKER_KEY || '';
  if (!token || !key) return ssoErrorPage(res, invalidMsg);
  let payload;
  try { payload = jwt.verify(token, key, { algorithms: ['HS256'] }); } catch (_) { return ssoErrorPage(res, invalidMsg); }
  if (!payload || payload.purpose !== 'tracker-sso' || !payload.email) return ssoErrorPage(res, invalidMsg);
  const email = String(payload.email).trim().toLowerCase();
  const name = String(payload.name || '').trim();
  const trackerRole = SSO_ROLES.includes(payload.tracker_role) ? payload.tracker_role : null;
  try {
    let u = (await pool.query('SELECT * FROM users WHERE lower(email) = $1', [email])).rows[0];
    if (!u) {
      // First visit: create the user. Never a super_admin, and the password
      // hash is a random throwaway so the account is SSO-only by default.
      if (!trackerRole) return ssoErrorPage(res, invalidMsg);
      const unusable = auth.hashPassword(crypto.randomBytes(32).toString('hex'));
      u = (await pool.query(
        'INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, true) RETURNING *',
        [name || email, email, unusable, trackerRole])).rows[0];
    } else {
      if (!u.is_active) return ssoErrorPage(res, 'Your tracker access is disabled. Ask an administrator to re-enable your account.');
      const newName = (name && name !== u.name) ? name : null;
      const newRole = (trackerRole && u.role !== 'super_admin' && trackerRole !== u.role) ? trackerRole : null;
      if (newName || newRole) {
        u = (await pool.query('UPDATE users SET name = COALESCE($1, name), role = COALESCE($2, role) WHERE id = $3 RETURNING *',
          [newName, newRole, u.id])).rows[0];
      }
    }
    auth.setAuthCookie(res, u);
    res.redirect('/');
  } catch (err) {
    console.error('[sso] failed:', err);
    ssoErrorPage(res, invalidMsg);
  }
});

// Everything else under /api requires a logged-in user.
app.use('/api', auth.requireAuth);

// ====== USERS (admins) ======
const userToClient = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.is_active });
app.get('/api/users', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at'); res.json(rows.map(userToClient)); }
  catch (err) { serverError(res, err); }
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
  } catch (err) { if (err.code === '23505') return res.status(400).json({ error: 'That email is already registered' }); serverError(res, err); }
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
  } catch (err) { serverError(res, err); }
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
    updatedAt: p.updated_at ? new Date(p.updated_at).toISOString() : '',
    projectedStartDate: p.projected_start_date || '',
    completedDate: p.completed_date || '',
  };
}

function projectValues(p) {
  return [
    d(p.jobNumber), p.name, d(p.customer), money(p.sellPrice), money(p.cost), d(p.pm),
    p.status || 'Awarded', p.drawingStatus || 'N/A',
    d(p.bidDueDate), d(p.submittedDate), d(p.awardDate), d(p.projectStartDate),
    d(p.fabStartDate), d(p.galvSendDate), d(p.galvReturnDate), d(p.paintSendDate),
    d(p.paintCompleteDate), p.materialOrdered ? true : false, d(p.notes),
  ];
}

// Server-side validation: reject any status value the app does not know about.
function validateProject(p) {
  if (!PROJECT_STATUSES.includes(p.status || 'Awarded')) return 'Invalid status: ' + p.status;
  if (!DRAWING_STATUSES.includes(p.drawingStatus || 'N/A')) return 'Invalid drawing status: ' + p.drawingStatus;
  return null;
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
    let out = rows.map(p => toClient(p, delByProj[p.id]));
    // Shop never sees money: blank out contract and cost.
    if (req.user.role === 'shop') out = out.map(c => ({ ...c, sellPrice: null, cost: null }));
    res.json(out);
  } catch (err) {
    serverError(res, err);
  }
});

// POST new project (DB generates the uuid; client id is ignored)
app.post('/api/projects', auth.requireRole('super_admin', 'admin', 'pm'), async (req, res) => {
  const p = req.body;
  const bad = validateProject(p);
  if (bad) return res.status(400).json({ error: bad });
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
    serverError(res, err);
  } finally {
    client.release();
  }
});

// PUT update project (records stage history when status changes)
app.put('/api/projects/:id', auth.requireRole('super_admin', 'admin', 'pm'), async (req, res) => {
  const p = req.body;
  const id = req.params.id;
  const bad = validateProject(p);
  if (bad) return res.status(400).json({ error: bad });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT status, updated_at FROM projects WHERE id = $1', [id]);
    if (prev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }
    // Conflict guard: if the row changed since the client loaded it, stop.
    if (p.expectedUpdatedAt) {
      const current = prev.rows[0].updated_at ? new Date(prev.rows[0].updated_at).toISOString() : '';
      if (current !== String(p.expectedUpdatedAt)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This job was changed by someone else since you opened it. Reload and try again.' });
      }
    }
    await client.query(
      `UPDATE projects SET
         job_number=$1, name=$2, customer=$3, original_contract=$4, cost=$5, pm=$6, status=$7,
         drawing_status=$8, bid_due_date=$9, submitted_date=$10, award_date=$11,
         project_start_date=$12, fab_start_date=$13, galv_send_date=$14, galv_return_date=$15,
         paint_send_date=$16, paint_complete_date=$17, material_ordered=$18, notes=$19,
         projected_start_date=$20, updated_at = now()
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
    serverError(res, err);
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
    serverError(res, err);
  }
});

// DELETE = archive (keep the record, just hide it). Admins only.
app.delete('/api/projects/:id', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE projects SET is_archived = true, archived_at = now(), archived_by = $2, updated_at = now() WHERE id = $1',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
});

// RESTORE an archived project back to the active list. Admins only.
app.post('/api/projects/:id/restore', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE projects SET is_archived = false, archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1',
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
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
    serverError(res, err);
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
      notes: a.notes || '', isRetainageRelease: !!a.is_retainage_release,
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
  } catch (err) { serverError(res, err); }
});

// ====== CHANGE ORDERS ======
const coToClient = c => ({ id: c.id, coNumber: c.co_number, description: c.description || '', amount: Number(c.amount || 0), status: c.status, submittedDate: c.submitted_date || '', approvedDate: c.approved_date || '', paidDate: c.paid_date || '' });
app.get('/api/projects/:id/change-orders', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM change_orders WHERE project_id = $1 ORDER BY co_number', [req.params.id]);
    let out = rows.map(coToClient);
    // Shop sees C/O titles and status but never the dollars.
    if (req.user.role === 'shop') out = out.map(c => ({ ...c, amount: null }));
    res.json(out);
  }
  catch (err) { serverError(res, err); }
});
app.post('/api/projects/:id/change-orders', auth.requireRole('super_admin', 'admin', 'accounting', 'pm'), async (req, res) => {
  const c = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO change_orders (project_id, co_number, description, amount, status, submitted_date, approved_date, paid_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, c.coNumber, d(c.description), money(c.amount) || 0, c.status || 'Pending', d(c.submittedDate), d(c.approvedDate), d(c.paidDate), req.user.id]);
    res.json(coToClient(rows[0]));
  } catch (err) { serverError(res, err); }
});
app.put('/api/change-orders/:coId', auth.requireRole('super_admin', 'admin', 'accounting', 'pm'), async (req, res) => {
  const c = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE change_orders SET co_number=$1, description=$2, amount=$3, status=$4, submitted_date=$5, approved_date=$6, paid_date=$7 WHERE id=$8 RETURNING *`,
      [c.coNumber, d(c.description), money(c.amount) || 0, c.status || 'Pending', d(c.submittedDate), d(c.approvedDate), d(c.paidDate), req.params.coId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(coToClient(rows[0]));
  } catch (err) { serverError(res, err); }
});
app.delete('/api/change-orders/:coId', auth.requireRole('super_admin', 'admin', 'accounting', 'pm'), async (req, res) => {
  try { await pool.query('DELETE FROM change_orders WHERE id = $1', [req.params.coId]); res.json({ ok: true }); }
  catch (err) { serverError(res, err); }
});

// ====== INVOICES / PAY APPS ======
app.get('/api/projects/:id/invoices', requireFinancial, async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM invoices WHERE project_id = $1', [req.params.id]); res.json(invoiceRows(rows)); }
  catch (err) { serverError(res, err); }
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
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Pay app #' + (parseInt(a.applicationNumber) || 1) + ' already exists for this job' });
    serverError(res, err);
  }
});
app.put('/api/invoices/:invId', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  const a = req.body;
  const held = (a.retainageHeld != null && a.retainageHeld !== '') ? money(a.retainageHeld) : null;
  try {
    const { rowCount } = await pool.query(
      `UPDATE invoices SET application_number=$1, period_end=$2, work_completed_to_date=$3, retainage_pct=$4, retainage_held=$5, status=$6, submitted_date=$7, approved_date=$8, notes=$9, amount_paid=$10, paid_date=$11 WHERE id=$12`,
      [parseInt(a.applicationNumber) || 1, d(a.periodEnd), money(a.workCompletedToDate) || 0, money(a.retainagePct) || 10, held, a.status || 'Draft', d(a.submittedDate), d(a.approvedDate), d(a.notes), money(a.amountPaid), d(a.paidDate), req.params.invId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Pay app #' + (parseInt(a.applicationNumber) || 1) + ' already exists for this job' });
    serverError(res, err);
  }
});
app.post('/api/invoices/:invId/payment', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  const p = req.body;
  try {
    const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.invId])).rows[0];
    if (!inv) return res.status(404).json({ error: 'Not found' });
    const amt = money(p.amountPaid) || 0;
    if (amt <= 0) return res.status(400).json({ error: 'Enter a payment amount' });
    // Payments accumulate; the app is Paid once they cover the amount due.
    const all = (await pool.query('SELECT * FROM invoices WHERE project_id = $1', [inv.project_id])).rows;
    const row = invoiceRows(all).find(r => r.id === inv.id);
    const due = row ? Number(row.currentPaymentDue) : 0;
    const newPaid = Number(inv.amount_paid || 0) + amt;
    const status = newPaid >= due - 0.01 ? 'Paid' : 'Partially Paid';
    await pool.query(
      `UPDATE invoices SET amount_paid=$1, paid_date=$2, status=$3 WHERE id=$4`,
      [newPaid, d(p.paidDate) || new Date().toISOString().slice(0, 10), status, req.params.invId]);
    res.json({ ok: true, status, amountPaid: newPaid });
  } catch (err) { serverError(res, err); }
});
// Release retainage: creates the final pay app that bills out the held amount.
// Work completed stays the same and retainage drops to zero, so the payment
// due on the new app equals exactly the retainage held so far.
app.post('/api/projects/:id/release-retainage', requireFinancial, async (req, res) => {
  try {
    const raw = (await pool.query('SELECT * FROM invoices WHERE project_id = $1', [req.params.id])).rows;
    if (raw.some(a => a.is_retainage_release && a.status !== 'Paid')) {
      return res.status(400).json({ error: 'A retainage release pay app already exists on this job and has not been paid yet' });
    }
    const rows = invoiceRows(raw);
    const last = rows[rows.length - 1];
    const held = last ? Number(last.retainageHeld) : 0;
    if (!(held > 0.005)) return res.status(400).json({ error: 'No retainage is currently held on this job' });
    const appNo = raw.reduce((m, a) => Math.max(m, a.application_number), 0) + 1;
    const ins = await pool.query(
      `INSERT INTO invoices (project_id, application_number, work_completed_to_date, retainage_pct, retainage_held, is_retainage_release, status, submitted_date, notes, created_by)
       VALUES ($1,$2,$3,0,0,true,'Submitted',CURRENT_DATE,'Retainage release',$4) RETURNING id`,
      [req.params.id, appNo, last.workCompletedToDate, req.user.id]);
    res.json({ ok: true, id: ins.rows[0].id, applicationNumber: appNo, amount: held });
  } catch (err) { serverError(res, err); }
});
app.delete('/api/invoices/:invId', auth.requireRole('super_admin', 'admin', 'accounting'), async (req, res) => {
  try { await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.invId]); res.json({ ok: true }); }
  catch (err) { serverError(res, err); }
});

// ====== DOCUMENTS ======
const docToClient = f => ({ id: f.id, fileName: f.file_name, fileType: f.file_type || '', fileSize: Number(f.file_size || 0), category: f.category || 'general', changeOrderId: f.change_order_id, invoiceId: f.invoice_id, uploadedAt: f.uploaded_at, uploadedBy: f.uploaded_by_name || '' });
app.get('/api/projects/:id/documents', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dn.*, u.name AS uploaded_by_name FROM documents dn LEFT JOIN users u ON u.id = dn.uploaded_by
       WHERE dn.project_id = $1 ORDER BY dn.uploaded_at DESC`, [req.params.id]);
    res.json(rows.map(docToClient));
  } catch (err) { serverError(res, err); }
});
app.post('/api/projects/:id/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { rows } = await pool.query(
      `INSERT INTO documents (project_id, change_order_id, invoice_id, file_name, file_type, file_size, storage_key, category, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, d(req.body.changeOrderId), d(req.body.invoiceId), req.file.originalname, req.file.mimetype, req.file.size, req.file.filename, d(req.body.category) || 'general', req.user.id]);
    res.json(docToClient(rows[0]));
  } catch (err) { serverError(res, err); }
});
app.get('/api/documents/:docId/download', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [req.params.docId]);
    if (!rows.length) return res.status(404).send('Not found');
    res.download(path.join(UPLOAD_DIR, rows[0].storage_key), rows[0].file_name);
  } catch (err) { serverError(res, err); }
});
app.delete('/api/documents/:docId', auth.requireRole('super_admin', 'admin', 'pm', 'accounting'), async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING storage_key', [req.params.docId]);
    if (rows.length) { try { fs.unlinkSync(path.join(UPLOAD_DIR, rows[0].storage_key)); } catch (_) {} }
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// ====== BILLING / RECEIVABLES (company-wide) ======
app.get('/api/billing', requireFinancial, async (req, res) => {
  try {
    // Every non-archived project counts toward receivables and retainage,
    // whatever its status. Only 'may need billing' is limited to active fab.
    const proj = (await pool.query('SELECT id, job_number, name, customer, original_contract, cost, status FROM projects WHERE is_archived = false')).rows;
    const inv = (await pool.query('SELECT * FROM invoices')).rows;
    const cos = (await pool.query('SELECT * FROM change_orders')).rows;
    const invByProj = {}, coByProj = {};
    for (const i of inv) (invByProj[i.project_id] = invByProj[i.project_id] || []).push(i);
    for (const c of cos) (coByProj[c.project_id] = coByProj[c.project_id] || []).push(c);
    const ACTIVE_FAB = ['In Fabrication', 'Ready for Galvanizing/Paint', 'In Galvanizing', 'In Paint', 'Shipping', 'Field/Erection'];
    let billedToDate = 0, collected = 0, retainageHeld = 0;
    const open = [], paidHist = [], needsBilling = [], retainageOutstanding = [], margin = [];
    for (const p of proj) {
      const rows = invoiceRows(invByProj[p.id] || []);
      const last = rows[rows.length - 1];
      const contractSum = Number(p.original_contract || 0) + approvedCoTotal(coByProj[p.id] || []);
      const pBilled = last ? last.workCompletedToDate : 0;
      const pRet = last ? last.retainageHeld : 0;
      const pPaid = (invByProj[p.id] || []).reduce((s, i) => s + Number(i.amount_paid || 0), 0);
      billedToDate += pBilled; retainageHeld += pRet; collected += pPaid;
      for (const a of rows) {
        if (a.status === 'Submitted' || a.status === 'Approved' || a.status === 'Partially Paid') {
          const days = daysSince(a.submittedDate);
          const remaining = a.currentPaymentDue - Number(a.amountPaid || 0);
          open.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', applicationNumber: a.applicationNumber, submittedDate: a.submittedDate, days, overdue: days > NET_DAYS, thisPeriod: a.currentPaymentDue, due: remaining, status: a.status, isRetainageRelease: a.isRetainageRelease });
        }
        if (a.status === 'Paid' && a.amountPaid) paidHist.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', applicationNumber: a.applicationNumber, paidDate: a.paidDate, amountPaid: Number(a.amountPaid), isRetainageRelease: a.isRetainageRelease });
      }
      if (ACTIVE_FAB.includes(p.status)) {
        const unbilled = contractSum - pBilled;
        if (unbilled > 0) needsBilling.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', status: p.status, unbilled, lastBilled: last ? last.periodEnd : null });
      }
      // Retainage aging: any job (Completed included) still holding retainage
      // with no paid release app yet.
      const hasPaidRelease = rows.some(a => a.isRetainageRelease && a.status === 'Paid');
      if (pRet > 0.005 && !hasPaidRelease) {
        const lastAppDate = last ? (last.periodEnd || last.submittedDate || '') : '';
        retainageOutstanding.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', status: p.status, amount: pRet, daysHeld: daysSince(lastAppDate), lastAppDate });
      }
      // Margin roll-up across active jobs.
      if (ACTIVE_STAGES.includes(p.status)) {
        const cost = Number(p.cost || 0);
        margin.push({ projectId: p.id, jobNumber: p.job_number || '', name: p.name, customer: p.customer || '', status: p.status, contractSum, cost, marginDollars: contractSum - cost, marginPct: contractSum > 0 ? (contractSum - cost) / contractSum * 100 : 0 });
      }
    }
    open.sort((a, b) => b.days - a.days); needsBilling.sort((a, b) => b.unbilled - a.unbilled); paidHist.sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));
    retainageOutstanding.sort((a, b) => b.daysHeld - a.daysHeld);
    margin.sort((a, b) => b.contractSum - a.contractSum);
    const marginTotals = { contractSum: 0, cost: 0 };
    for (const m of margin) { marginTotals.contractSum += m.contractSum; marginTotals.cost += m.cost; }
    marginTotals.marginDollars = marginTotals.contractSum - marginTotals.cost;
    marginTotals.marginPct = marginTotals.contractSum > 0 ? marginTotals.marginDollars / marginTotals.contractSum * 100 : 0;
    const outstanding = open.reduce((s, o) => s + o.due, 0);
    const overdue = open.filter(o => o.overdue).reduce((s, o) => s + o.due, 0);
    res.json({ billedToDate, collected, outstanding, overdue, retainageHeld, netDays: NET_DAYS, open, paidHist, needsBilling, retainageOutstanding, margin, marginTotals });
  } catch (err) { serverError(res, err); }
});


// ====== PROJECT NOTES (running log) ======
app.get('/api/projects/:id/notes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.body, n.created_at, u.name AS author
       FROM project_notes n LEFT JOIN users u ON u.id = n.created_by
       WHERE n.project_id = $1 ORDER BY n.created_at DESC`, [req.params.id]);
    res.json(rows.map(r => ({ id: r.id, body: r.body, createdAt: r.created_at, author: r.author || '' })));
  } catch (err) { serverError(res, err); }
});
app.post('/api/projects/:id/notes', async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note is empty' });
  try {
    const { rows } = await pool.query('INSERT INTO project_notes (project_id, body, created_by) VALUES ($1, $2, $3) RETURNING id', [req.params.id, body, req.user.id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { serverError(res, err); }
});

// ====== SEQUENCES (per-job, each with its own milestone dates) ======
const SEQ_DONE = st => st === 'Shipped' || st === 'Erected';
const seqToClient = q => ({ id: q.id, description: q.description || '', status: q.status || 'Not started', done: !!q.done, fabDate: q.fab_date || '', galvOut: q.galv_out_date || '', galvBack: q.galv_back_date || '', paintDate: q.paint_date || '', shipDate: q.ship_date || '', erectDate: q.erect_date || '', sortOrder: q.sort_order });
app.get('/api/projects/:id/sequences', async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM deliveries WHERE project_id = $1 ORDER BY sort_order NULLS LAST, ship_date NULLS LAST', [req.params.id]); res.json(rows.map(seqToClient)); }
  catch (err) { serverError(res, err); }
});
app.post('/api/projects/:id/sequences', auth.requireRole('super_admin', 'admin', 'pm', 'shop'), async (req, res) => {
  const q = req.body;
  if (!SEQUENCE_STATUSES.includes(q.status || 'Not started')) return res.status(400).json({ error: 'Invalid sequence status: ' + q.status });
  try {
    const { rows } = await pool.query(
      `INSERT INTO deliveries (project_id, description, status, done, fab_date, galv_out_date, galv_back_date, paint_date, ship_date, erect_date, delivery_date, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11) RETURNING *`,
      [req.params.id, d(q.description), q.status || 'Not started', SEQ_DONE(q.status), d(q.fabDate), d(q.galvOut), d(q.galvBack), d(q.paintDate), d(q.shipDate), d(q.erectDate), parseInt(q.sortOrder) || 0]);
    res.json(seqToClient(rows[0]));
  } catch (err) { serverError(res, err); }
});
app.put('/api/sequences/:seqId', auth.requireRole('super_admin', 'admin', 'pm', 'shop'), async (req, res) => {
  const q = req.body;
  if (!SEQUENCE_STATUSES.includes(q.status || 'Not started')) return res.status(400).json({ error: 'Invalid sequence status: ' + q.status });
  try {
    const { rowCount } = await pool.query(
      `UPDATE deliveries SET description=$1, status=$2, done=$3, fab_date=$4, galv_out_date=$5, galv_back_date=$6, paint_date=$7, ship_date=$8, delivery_date=$8, erect_date=$9 WHERE id=$10`,
      [d(q.description), q.status || 'Not started', SEQ_DONE(q.status), d(q.fabDate), d(q.galvOut), d(q.galvBack), d(q.paintDate), d(q.shipDate), d(q.erectDate), req.params.seqId]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});
app.delete('/api/sequences/:seqId', auth.requireRole('super_admin', 'admin', 'pm', 'shop'), async (req, res) => {
  try { await pool.query('DELETE FROM deliveries WHERE id = $1', [req.params.seqId]); res.json({ ok: true }); }
  catch (err) { serverError(res, err); }
});

// Email everyone on the tracker's notification list that a new job has landed.
// Defensive by design: if email is not configured, the recipient table is not
// there yet, or nobody is on the list, it simply does nothing. It never throws
// into the caller, so a mail problem can never block creating a project.
async function notifyNewProject(p) {
  try {
    if (!mailer.isConfigured()) return;
    let recips = [];
    try {
      recips = (await pool.query('SELECT email, name FROM tracker_notification_recipients WHERE active = true')).rows;
    } catch (_) { return; } // table not created yet
    if (!recips.length) return;
    const amt = money(p.contract_amount);
    const contract = amt == null ? '' : ('USD ' + amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const base = (process.env.PUBLIC_URL || '').replace(/[\/]+$/, '');
    const link = base ? (base + '/') : '';
    const subject = 'New job ' + p.job_number + ' - ' + (p.name || '');
    const rows = [
      ['Job number', p.job_number],
      ['Project', p.name || ''],
      ['Customer', p.customer || ''],
      ['Contract', contract],
    ].filter(r => r[1] !== '' && r[1] != null)
      .map(r => '<tr><td style="padding:4px 12px 4px 0;color:#6b7889">' + r[0] + '</td><td style="padding:4px 0;font-weight:600">' + escapeHtml(r[1]) + '</td></tr>').join('');
    const html = '<p>A new job has been added to the R&R Project Tracker at the <b>Awarded</b> stage.</p>' +
      '<table style="border-collapse:collapse;font-size:14px">' + rows + '</table>' +
      (link ? ('<p style="margin-top:16px"><a href="' + link + '">Open the tracker</a></p>') : '');
    const text = 'A new job has been added to the R&R Project Tracker (Awarded stage).\n' +
      'Job number: ' + p.job_number + '\nProject: ' + (p.name || '') + '\nCustomer: ' + (p.customer || '') + (contract ? ('\nContract: ' + contract) : '') + (link ? ('\n\nOpen the tracker: ' + link) : '');
    for (const r of recips) {
      try { await mailer.sendMail({ to: r.email, subject, html, text }); }
      catch (e) { console.error('[notify] send to ' + r.email + ' failed:', e.message); }
    }
  } catch (e) {
    console.error('[notify] error:', e.message);
  }
}

// Shared by the pull import and the real-time push. Creates one project at the
// 'Awarded' stage from a won bid, keyed on job_number so the same job can never
// create two projects. Returns the new project id, or null if a project with
// that job number already exists (nothing is changed in that case).
async function createProjectFromWonJob(client, j, createdBy) {
  const jobNo = String(j.job_number || '').trim();
  if (!jobNo) return null;
  const exists = await client.query('SELECT 1 FROM projects WHERE job_number = $1 LIMIT 1', [jobNo]);
  if (exists.rowCount) return null;
  const ins = await client.query(
    'INSERT INTO projects (job_number, name, customer, original_contract, cost, status, award_date, source_estimate_id, source_bid_number, imported_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10) RETURNING id',
    [jobNo, j.project_name || ('Job ' + jobNo), d(j.client_gc), money(j.contract_amount), money(j.cost), 'Awarded', d(String(j.won_at || '').slice(0, 10)), j.estimate_id || null, d(j.bid_number), createdBy || null]);
  await client.query('INSERT INTO stage_history (project_id, status, changed_by) VALUES ($1, $2, $3)', [ins.rows[0].id, 'Awarded', createdBy || null]);
  return ins.rows[0].id;
}

// ====== IMPORT WON JOBS FROM THE BID TOOL (manual pull, admin-only) ======
// Pulls the bid tool's won-jobs feed and creates a project for any job number
// not already in the tracker. Idempotent: existing job numbers skip.
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
    console.error('[import] fetch failed:', err);
    return res.status(502).json({ error: 'Could not reach the bid tool.' });
  }
  const jobs = (feed && feed.jobs) || [];
  const client = await pool.connect();
  const imported = [], skipped = [], newJobs = [];
  try {
    await client.query('BEGIN');
    for (const j of jobs) {
      const jobNo = String(j.job_number || '').trim();
      if (!jobNo) continue;
      const newId = await createProjectFromWonJob(client, j, req.user.id);
      if (newId) { imported.push(jobNo); newJobs.push({ id: newId, job_number: jobNo, name: j.project_name || ('Job ' + jobNo), customer: j.client_gc, contract_amount: j.contract_amount }); }
      else { skipped.push(jobNo); }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  } finally {
    client.release();
  }
  for (const nj of newJobs) notifyNewProject(nj).catch(e => console.error('[notify] failed:', e.message));
  res.json({ ok: true, importedCount: imported.length, skippedCount: skipped.length, imported, skipped });
});

// ====== NOTIFICATION RECIPIENTS (admin only) ======
// The people emailed when a new job lands in the tracker. Managed in-app so
// admins can change the list without a code change.
app.get('/api/notification-recipients', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, active, created_at FROM tracker_notification_recipients ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) { serverError(res, err); }
});
app.post('/api/notification-recipients', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const name = String((req.body || {}).name || '').trim();
  const active = (req.body || {}).active === false ? false : true;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO tracker_notification_recipients (email, name, active) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active RETURNING id, email, name, active, created_at',
      [email, name, active]);
    res.status(201).json(rows[0]);
  } catch (err) { serverError(res, err); }
});
app.put('/api/notification-recipients/:id', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.email != null) { const e = String(b.email).trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Invalid email.' }); sets.push('email = $' + (vals.push(e))); }
  if (b.name != null) { sets.push('name = $' + (vals.push(String(b.name).trim()))); }
  if (b.active != null) { sets.push('active = $' + (vals.push(!!b.active))); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query('UPDATE tracker_notification_recipients SET ' + sets.join(', ') + ' WHERE id = $' + vals.length + ' RETURNING id, email, name, active, created_at', vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { serverError(res, err); }
});
app.delete('/api/notification-recipients/:id', auth.requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM tracker_notification_recipients WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
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

// ====== ADMIN "NOTIFICATION RECIPIENTS" PAGE ======
// Simple in-app screen for admins to manage who gets the new-job email.
// Visit /admin/notifications while logged in as an admin.
app.get('/admin/notifications', (req, res) => {
  res.type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>New-job email recipients - R&R Project Tracker</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f6f9;color:#1c2430;margin:0;padding:40px;display:flex;justify-content:center}' +
    '.card{background:#fff;border:1px solid #e2e7ee;border-radius:14px;padding:28px;max-width:620px;width:100%}' +
    'h1{font-size:20px;margin:0 0 4px}p.sub{color:#6b7889;font-size:13px;margin:0 0 20px}' +
    'input{padding:10px;border:1px solid #cbd3de;border-radius:8px;font-size:14px}' +
    '.row{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.row input.email{flex:2;min-width:200px}.row input.name{flex:1;min-width:140px}' +
    'button{background:#d98521;color:#3a2400;border:0;border-radius:9px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer}' +
    'button.link{background:none;color:#b23b3b;font-weight:600;padding:4px 8px}button.toggle{background:#eef1f5;color:#3a4656;font-weight:600;padding:4px 10px}' +
    'table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid #eef1f5}' +
    'th{color:#6b7889;font-weight:600;font-size:12px}.muted{color:#93a0b0}.err{color:#b23b3b;font-size:13px;margin-top:10px}a{color:#2f6fb0}</style></head><body><div class="card">' +
    '<h1>New-job email recipients</h1>' +
    '<p class="sub">These people are emailed automatically whenever a new job is created in the tracker from a won bid. Inactive recipients stay on the list but are skipped.</p>' +
    '<div class="row"><input class="email" id="email" type="email" placeholder="email@rrfab.com"><input class="name" id="name" type="text" placeholder="Name (optional)"><button id="add">Add</button></div>' +
    '<div id="err" class="err"></div>' +
    '<table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th></th></tr></thead><tbody id="list"><tr><td colspan="4" class="muted">Loading...</td></tr></tbody></table>' +
    '<p style="margin-top:22px"><a href="/">Back to the tracker</a></p>' +
    '<script>' +
    'var listEl=document.getElementById("list"),errEl=document.getElementById("err");' +
    'function esc(t){var d=document.createElement("div");d.textContent=(t==null?"":String(t));return d.innerHTML;}' +
    'function api(method,path,body){return fetch(path,{method:method,headers:{"Content-Type":"application/json"},credentials:"same-origin",body:body?JSON.stringify(body):undefined});}' +
    'function show(msg){errEl.textContent=msg||"";}' +
    'function load(){api("GET","/api/notification-recipients").then(function(r){if(r.status===401){listEl.innerHTML=\'<tr><td colspan=4>Please log in as an admin, then reload.</td></tr>\';return null;}if(r.status===403){listEl.innerHTML=\'<tr><td colspan=4>You need an admin account.</td></tr>\';return null;}return r.json();}).then(function(rows){if(!rows)return;render(rows);}).catch(function(e){show("Could not load: "+e.message);});}' +
    'function render(rows){if(!rows.length){listEl.innerHTML=\'<tr><td colspan=4 class=muted>No recipients yet. Add one above.</td></tr>\';return;}listEl.innerHTML=rows.map(function(x){' +
    'var status=x.active?"Active":"<span class=muted>Inactive</span>";' +
    'return "<tr data-id="+x.id+"><td>"+esc(x.email)+"</td><td>"+esc(x.name)+"</td><td>"+status+"</td>"+' +
    '"<td style=text-align:right><button class=toggle data-act="+(x.active?"off":"on")+">"+(x.active?"Deactivate":"Activate")+"</button> <button class=link data-del=1>Remove</button></td></tr>";}).join("");}' +
    'document.getElementById("add").onclick=function(){show("");var email=document.getElementById("email").value.trim();var name=document.getElementById("name").value.trim();if(!email){show("Enter an email.");return;}' +
    'api("POST","/api/notification-recipients",{email:email,name:name}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(o){if(!o.ok){show(o.j.error||"Could not add.");return;}document.getElementById("email").value="";document.getElementById("name").value="";load();}).catch(function(e){show(e.message);});};' +
    'listEl.onclick=function(ev){var tr=ev.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");' +
    'if(ev.target.hasAttribute("data-del")){if(!confirm("Remove this recipient?"))return;api("DELETE","/api/notification-recipients/"+id).then(function(){load();});}' +
    'else if(ev.target.classList.contains("toggle")){var act=ev.target.getAttribute("data-act")==="on";api("PUT","/api/notification-recipients/"+id,{active:act}).then(function(){load();});}};' +
    'load();' +
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
