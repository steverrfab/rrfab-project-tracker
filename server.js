const express = require('express');
const path = require('path');
const { pool, runMigrations } = require('./migrate');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

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
      id: x.id, date: x.delivery_date || '', desc: x.description || '', done: !!x.done,
    })),
    notes: p.notes || '',
    createdAt: p.created_at ? new Date(p.created_at).toISOString() : '',
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
app.post('/api/projects', async (req, res) => {
  const p = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO projects (
         job_number, name, customer, original_contract, cost, pm, status, drawing_status,
         bid_due_date, submitted_date, award_date, project_start_date, fab_start_date,
         galv_send_date, galv_return_date, paint_send_date, paint_complete_date,
         material_ordered, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id, status`,
      projectValues(p)
    );
    const id = ins.rows[0].id;
    await replaceDeliveries(client, id, p.deliveries);
    await client.query(
      'INSERT INTO stage_history (project_id, status) VALUES ($1, $2)',
      [id, ins.rows[0].status]
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
app.put('/api/projects/:id', async (req, res) => {
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
         paint_send_date=$16, paint_complete_date=$17, material_ordered=$18, notes=$19
       WHERE id=$20`,
      [...projectValues(p), id]
    );
    await replaceDeliveries(client, id, p.deliveries);
    if (prev.rows[0].status !== p.status) {
      await client.query(
        'INSERT INTO stage_history (project_id, status) VALUES ($1, $2)',
        [id, p.status]
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

// DELETE = archive (keep the record, just hide it)
app.delete('/api/projects/:id', async (req, res) => {
  try {
    await pool.query('UPDATE projects SET is_archived = true WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
});

// Create the PostgreSQL tables on startup (non-fatal if it cannot connect).
runMigrations().catch(err => console.error('[migrate] failed:', err.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`R&R Project Tracker running on port ${PORT}`));
