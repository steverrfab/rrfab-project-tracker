const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

function toCamel(r) {
  return {
    id: r.id,
    name: r.name,
    customer: r.customer || '',
    sellPrice: r.sell_price,
    cost: r.cost,
    status: r.status,
    bidDueDate: r.bid_due_date || '',
    submittedDate: r.submitted_date || '',
    awardDate: r.award_date || '',
    projectStartDate: r.project_start_date || '',
    fabStartDate: r.fab_start_date || '',
    galvSendDate: r.galv_send_date || '',
    galvReturnDate: r.galv_return_date || '',
    paintSendDate: r.paint_send_date || '',
    paintCompleteDate: r.paint_complete_date || '',
    materialOrdered: !!r.material_ordered,
    pm: r.pm || '',
    drawingStatus: r.drawing_status || 'N/A',
    changeOrders: r.change_orders || 0,
    deliveryDate: r.delivery_date || '',
    deliveries: JSON.parse(r.deliveries || '[]'),
    notes: r.notes || '',
    createdAt: r.created_at || '',
  };
}

function bindParams(p) {
  return [
    p.name,
    p.customer || '',
    parseFloat(p.sellPrice) || null,
    parseFloat(p.cost) || null,
    p.status || 'Bidding',
    p.bidDueDate || null,
    p.submittedDate || null,
    p.awardDate || null,
    p.projectStartDate || null,
    p.fabStartDate || null,
    p.galvSendDate || null,
    p.galvReturnDate || null,
    p.paintSendDate || null,
    p.paintCompleteDate || null,
    p.materialOrdered ? 1 : 0,
    p.pm || '',
    p.drawingStatus || 'N/A',
    parseInt(p.changeOrders) || 0,
    p.deliveryDate || null,
    JSON.stringify(p.deliveries || []),
    p.notes || '',
  ];
}

// GET all projects
app.get('/api/projects', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    res.json(rows.map(toCamel));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST new project
app.post('/api/projects', (req, res) => {
  try {
    const p = req.body;
    db.prepare(`
      INSERT INTO projects (
        id, name, customer, sell_price, cost, status,
        bid_due_date, submitted_date, award_date, project_start_date,
        fab_start_date, galv_send_date, galv_return_date,
        paint_send_date, paint_complete_date,
        material_ordered, pm, drawing_status, change_orders,
        delivery_date, deliveries, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p.id, ...bindParams(p), p.createdAt || new Date().toISOString());
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT update project
app.put('/api/projects/:id', (req, res) => {
  try {
    const p = req.body;
    db.prepare(`
      UPDATE projects SET
        name=?, customer=?, sell_price=?, cost=?, status=?,
        bid_due_date=?, submitted_date=?, award_date=?, project_start_date=?,
        fab_start_date=?, galv_send_date=?, galv_return_date=?,
        paint_send_date=?, paint_complete_date=?,
        material_ordered=?, pm=?, drawing_status=?, change_orders=?,
        delivery_date=?, deliveries=?, notes=?
      WHERE id=?
    `).run(...bindParams(p), p.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE project
app.delete('/api/projects/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`R&R Project Tracker running on port ${PORT}`));
