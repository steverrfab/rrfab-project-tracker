import { useState, useEffect, useCallback } from 'react';

const STATUSES = {
  Bidding: '#3b82f6', Submitted: '#a855f7', Awarded: '#22c55e',
  Purchasing: '#f59e0b', 'In Fabrication': '#f97316',
  'Ready for Galvanizing/Paint': '#14b8a6', 'In Galvanizing': '#0d9488',
  'In Paint': '#7c3aed', Shipping: '#06b6d4', 'Field/Erection': '#84cc16',
  Completed: '#6b7280', 'Lost/On Hold': '#ef4444',
};
const STAT_KEYS = Object.keys(STATUSES);
const DRW = ['N/A', 'Not Started', 'In Progress', 'Approved', 'Revision Needed'];
const PMS = ['Joe Jenkins', 'Steve Moskowitz', 'Tanja', 'Unassigned'];

const BG = '#0c0c0c', SURF = '#141414', SURF2 = '#1a1a1a';
const BORD = '#252525', BORD2 = '#2e2e2e';
const TEXT = '#e8e8e8', MUTED = '#555', DIM = '#777', ACCENT = '#e85d04';

const sc = (s) => STATUSES[s] || '#666';
const fmtV = (v) => { const n = parseFloat(v); if ((!v && v !== 0) || isNaN(n)) return '--'; if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'K'; return '$' + Math.round(n); };
const fmtD = (d) => { if (!d) return '--'; return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const fmtPct = (n) => isNaN(n) || n === 0 ? '--' : n.toFixed(1) + '%';
const gpCalc = (p) => (parseFloat(p.sellPrice) || 0) - (parseFloat(p.cost) || 0);
const gmCalc = (p) => { const sp = parseFloat(p.sellPrice) || 0; return sp > 0 ? (gpCalc(p) / sp * 100) : 0; };

function getDateCols(f) {
  if (f === 'Bidding')                     return [{ key: 'bidDueDate', label: 'Bid due' }];
  if (f === 'Submitted')                   return [{ key: 'submittedDate', label: 'Submitted' }];
  if (f === 'Awarded')                     return [{ key: 'fabStartDate', label: 'Fab start' }, { key: 'deliveryDate', label: 'Delivery to site' }];
  if (f === 'Purchasing')                  return [{ key: 'fabStartDate', label: 'Fab start' }];
  if (f === 'In Fabrication')              return [{ key: 'fabStartDate', label: 'Fab start' }, { key: 'deliveryDate', label: 'Delivery to site' }];
  if (f === 'Ready for Galvanizing/Paint') return [{ key: 'galvSendDate', label: 'Ships to finisher' }];
  if (f === 'In Galvanizing')              return [{ key: 'galvSendDate', label: 'Sent to galv' }, { key: 'galvReturnDate', label: 'Est. return' }, { key: 'deliveryDate', label: 'Delivery to site' }];
  if (f === 'In Paint')                    return [{ key: 'paintSendDate', label: 'Paint start' }, { key: 'paintCompleteDate', label: 'Est. complete' }];
  if (f === 'Shipping')                    return [{ key: 'deliveryDate', label: 'Delivery to site' }];
  if (f === 'Field/Erection')              return [{ key: 'deliveryDate', label: 'Delivery to site' }];
  if (f === 'Completed')                   return [{ key: 'deliveryDate', label: 'Delivered' }];
  if (f === 'Lost/On Hold')                return [{ key: 'bidDueDate', label: 'Bid due' }];
  return [{ key: 'bidDueDate', label: 'Bid due' }, { key: 'fabStartDate', label: 'Fab start' }];
}

const blankProject = () => ({
  id: Date.now().toString(), jobNumber: '', name: '', customer: '',
  sellPrice: '', cost: '', status: 'Bidding',
  bidDueDate: '', submittedDate: '', awardDate: '',
  projectStartDate: '', fabStartDate: '',
  galvSendDate: '', galvReturnDate: '',
  paintSendDate: '', paintCompleteDate: '',
  materialOrdered: false, pm: 'Joe Jenkins',
  drawingStatus: 'N/A', changeOrders: 0,
  deliveryDate: '', deliveries: [], notes: '',
  createdAt: new Date().toISOString(),
});

const INP = {
  background: '#111', border: '1px solid ' + BORD2, borderRadius: 4,
  color: TEXT, padding: '7px 9px', fontSize: 13, outline: 'none',
  fontFamily: 'inherit', width: '100%',
};
const BTN = { border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 };

// ── Shared UI primitives (outside any component to keep refs stable) ──────────

function FldLabel({ label }) {
  return <label style={{ color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em' }}>{label}</label>;
}

function TxtField({ value, onChange, label, type = 'text', placeholder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <FldLabel label={label} />
      <input type={type} value={value ?? ''} onChange={onChange} placeholder={placeholder || ''} style={INP} />
    </div>
  );
}

function SelField({ value, onChange, label, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <FldLabel label={label} />
      <select value={value} onChange={onChange} style={INP}>
        {options.map(o => { const v = o.label || o; return <option key={v} value={v} style={{ background: SURF }}>{v}</option>; })}
      </select>
    </div>
  );
}

function CalcField({ label, val, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <FldLabel label={label} />
      <div style={{ background: '#0a0a0a', border: '1px solid #1e1e1e', borderRadius: 4, padding: '7px 9px', fontSize: 13, fontWeight: 700, color }}>{val}</div>
    </div>
  );
}

function Sect({ label }) {
  return <div style={{ color: '#444', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 10, marginTop: 4 }}>{label}</div>;
}
function Hr() { return <div style={{ borderTop: '1px solid ' + BORD, margin: '16px 0' }} />; }
function Grid2({ children, mb = 0 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: mb }}>{children}</div>;
}

// ── Modal is its own component — typing only re-renders this, not the table ───

function ProjectModal({ initialForm, initialDeliveries, mode, onSave, onClose, saving }) {
  const [form, setForm] = useState(initialForm);
  const [dlv, setDlv] = useState(initialDeliveries);

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));
  const setNum = (field) => (e) => setForm(f => ({ ...f, [field]: parseInt(e.target.value) || 0 }));

  const cGP = gpCalc(form);
  const cGM = gmCalc(form);

  const handleSave = () => {
    if (!form.name.trim()) return;
    onSave({ ...form, deliveries: dlv.filter(d => d.date || d.desc) });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}>
      <div style={{ background: SURF2, border: '1px solid ' + BORD2, borderRadius: 10, width: '100%', maxWidth: 720, padding: 26, maxHeight: '92vh', overflowY: 'auto' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{mode === 'add' ? 'New project' : 'Edit project'}</div>
          <button onClick={onClose} style={{ ...BTN, background: 'transparent', color: MUTED, fontSize: 22, lineHeight: 1 }}>x</button>
        </div>

        <Sect label="Project info" />
        <Grid2 mb={14}>
          <TxtField label="Job #" value={form.jobNumber} onChange={set('jobNumber')} placeholder="e.g. 2026-041" />
          <TxtField label="Project name" value={form.name} onChange={set('name')} />
          <TxtField label="Customer / GC" value={form.customer} onChange={set('customer')} />
          <SelField label="Status" value={form.status} onChange={set('status')} options={STAT_KEYS} />
          <SelField label="PM assignment" value={form.pm} onChange={set('pm')} options={PMS} />
        </Grid2>

        <Hr /><Sect label="Financials" />
        <Grid2 mb={14}>
          <TxtField label="Selling price ($)" value={form.sellPrice} onChange={set('sellPrice')} type="number" />
          <TxtField label="Our cost ($)" value={form.cost} onChange={set('cost')} type="number" />
          <CalcField label="Gross profit (auto)" val={form.sellPrice || form.cost ? fmtV(cGP) : '--'} color={cGP >= 0 ? '#4ade80' : '#ef4444'} />
          <CalcField label="Gross margin (auto)" val={form.sellPrice && form.cost ? fmtPct(cGM) : '--'} color={cGM >= 20 ? '#4ade80' : cGM >= 15 ? '#f59e0b' : '#ef4444'} />
        </Grid2>

        <Hr /><Sect label="Schedule" />
        <Grid2 mb={14}>
          <TxtField label="Bid due date" value={form.bidDueDate} onChange={set('bidDueDate')} type="date" />
          <TxtField label="Date submitted" value={form.submittedDate} onChange={set('submittedDate')} type="date" />
          <TxtField label="Award date" value={form.awardDate} onChange={set('awardDate')} type="date" />
          <TxtField label="Project start date" value={form.projectStartDate} onChange={set('projectStartDate')} type="date" />
          <TxtField label="Our fabrication start" value={form.fabStartDate} onChange={set('fabStartDate')} type="date" />
          <TxtField label="Target final delivery" value={form.deliveryDate} onChange={set('deliveryDate')} type="date" />
          <TxtField label="Change orders (#)" value={form.changeOrders} onChange={setNum('changeOrders')} type="number" />
        </Grid2>

        <Hr /><Sect label="Delivery phases" />
        <div style={{ color: MUTED, fontSize: 11, marginBottom: 10 }}>Add a line per delivery. Use the arrow on the table to expand and check off as each phase ships.</div>
        {dlv.length === 0 && <div style={{ color: '#444', fontSize: 12, marginBottom: 8 }}>No delivery phases added yet.</div>}
        {dlv.map((d, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr auto auto', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="date" value={d.date || ''} onChange={e => setDlv(prev => prev.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} style={INP} />
            <input type="text" value={d.desc || ''} onChange={e => setDlv(prev => prev.map((x, j) => j === i ? { ...x, desc: e.target.value } : x))} placeholder="Description" style={INP} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: MUTED, fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer' }}>
              <input type="checkbox" checked={d.done} onChange={e => setDlv(prev => prev.map((x, j) => j === i ? { ...x, done: e.target.checked } : x))} style={{ accentColor: '#22c55e' }} />
              Done
            </label>
            <button onClick={() => setDlv(prev => prev.filter((_, j) => j !== i))} style={{ ...BTN, background: 'transparent', border: '1px solid #ef444433', color: '#ef444466', borderRadius: 4, padding: '3px 8px', fontSize: 11 }}>Remove</button>
          </div>
        ))}
        <button onClick={() => setDlv(prev => [...prev, { id: Date.now().toString(), date: '', desc: '', done: false }])} style={{ ...BTN, background: 'transparent', border: '1px solid ' + BORD2, color: MUTED, borderRadius: 4, padding: '6px 14px', fontSize: 11, marginTop: 4 }}>+ Add delivery phase</button>

        <Hr /><Sect label="Galvanizing" />
        <Grid2 mb={14}>
          <TxtField label="Sent to galvanizer" value={form.galvSendDate} onChange={set('galvSendDate')} type="date" />
          <TxtField label="Est. return from galv" value={form.galvReturnDate} onChange={set('galvReturnDate')} type="date" />
        </Grid2>

        <Hr /><Sect label="Paint" />
        <Grid2 mb={14}>
          <TxtField label="Paint start date" value={form.paintSendDate} onChange={set('paintSendDate')} type="date" />
          <TxtField label="Est. paint complete" value={form.paintCompleteDate} onChange={set('paintCompleteDate')} type="date" />
        </Grid2>

        <Hr /><Sect label="Materials and drawings" />
        <Grid2 mb={14}>
          <SelField label="Drawing status" value={form.drawingStatus} onChange={set('drawingStatus')} options={DRW} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <FldLabel label="Material ordered" />
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              {[true, false].map(v => (
                <button key={String(v)} onClick={() => setForm(f => ({ ...f, materialOrdered: v }))}
                  style={{ ...BTN, flex: 1, padding: '7px 0', borderRadius: 4, fontWeight: 600, fontSize: 12,
                    border: '1px solid ' + (form.materialOrdered === v ? (v ? '#22c55e' : '#ef4444') : BORD2),
                    background: form.materialOrdered === v ? (v ? '#22c55e22' : '#ef444422') : 'transparent',
                    color: form.materialOrdered === v ? (v ? '#22c55e' : '#ef4444') : MUTED }}>
                  {v ? 'Yes' : 'No'}
                </button>
              ))}
            </div>
          </div>
        </Grid2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
          <FldLabel label="Notes" />
          <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...INP, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...BTN, background: 'transparent', border: '1px solid ' + BORD2, color: DIM, borderRadius: 6, padding: '8px 18px' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ ...BTN, background: saving ? BORD2 : ACCENT, color: '#fff', borderRadius: 6, padding: '8px 22px', fontWeight: 700, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : mode === 'add' ? 'Add project' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete confirm ─────────────────────────────────────────────────────────────

function DeleteConfirm({ onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}>
      <div style={{ background: SURF2, border: '1px solid ' + BORD2, borderRadius: 10, padding: 28, maxWidth: 340, textAlign: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 8 }}>Delete this project?</div>
        <div style={{ color: MUTED, marginBottom: 24 }}>This cannot be undone.</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onCancel} style={{ ...BTN, background: 'transparent', border: '1px solid ' + BORD2, color: DIM, borderRadius: 6, padding: '8px 20px' }}>Cancel</button>
          <button onClick={onConfirm} style={{ ...BTN, background: '#ef4444', color: '#fff', borderRadius: 6, padding: '8px 20px', fontWeight: 700 }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState([]);
  const [filter, setFilter] = useState('All');
  const [modal, setModal] = useState(null); // null | { mode, project }
  const [delTarget, setDelTarget] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => { setProjects(data); setLoading(false); })
      .catch(() => { setError('Could not load projects.'); setLoading(false); });
  }, []);

  const apiSave = useCallback(async (method, url, body) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Save failed');
  }, []);

  const handleSave = async (p) => {
    setSaving(true);
    try {
      if (modal.mode === 'add') {
        await apiSave('POST', '/api/projects', p);
      } else {
        await apiSave('PUT', '/api/projects/' + p.id, p);
      }
      // Reload from the server so we use the canonical record (server-assigned id, etc.)
      const fresh = await fetch('/api/projects').then(r => r.json());
      setProjects(fresh);
      setModal(null);
    } catch { alert('Save failed. Please try again.'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    try {
      await fetch('/api/projects/' + delTarget, { method: 'DELETE' });
      setProjects(prev => prev.filter(p => p.id !== delTarget));
    } catch { alert('Delete failed.'); }
    finally { setDelTarget(null); }
  };

  const quickStatus = async (id, status) => {
    const p = projects.find(p => p.id === id);
    if (!p) return;
    const updated = { ...p, status };
    setProjects(prev => prev.map(x => x.id === id ? updated : x));
    try { await apiSave('PUT', '/api/projects/' + id, updated); }
    catch { setProjects(prev => prev.map(x => x.id === id ? p : x)); }
  };

  const toggleDelivery = async (pid, di, done) => {
    const p = projects.find(p => p.id === pid);
    if (!p) return;
    const deliveries = p.deliveries.map((d, i) => i === di ? { ...d, done } : d);
    const updated = { ...p, deliveries };
    setProjects(prev => prev.map(x => x.id === pid ? updated : x));
    try { await apiSave('PUT', '/api/projects/' + pid, updated); }
    catch { setProjects(prev => prev.map(x => x.id === pid ? p : x)); }
  };

  const toggleExpand = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const openAdd = () => setModal({ mode: 'add', project: blankProject() });
  const openEdit = (id) => { const p = projects.find(p => p.id === id); setModal({ mode: 'edit', project: p }); };

  // Metrics
  const active = projects.filter(p => !['Completed', 'Lost/On Hold'].includes(p.status));
  const ts = active.reduce((s, p) => s + (parseFloat(p.sellPrice) || 0), 0);
  const tc = active.reduce((s, p) => s + (parseFloat(p.cost) || 0), 0);
  const tg = ts - tc, avg = ts > 0 ? (tg / ts * 100) : 0;
  const bids = projects.filter(p => ['Bidding', 'Submitted'].includes(p.status));
  const blStr = ts >= 1e6 ? '$' + (ts / 1e6).toFixed(2) + 'M' : ts >= 1000 ? '$' + (ts / 1000).toFixed(0) + 'K' : '$' + Math.round(ts);
  const gpStr = tg >= 1e6 ? '$' + (tg / 1e6).toFixed(2) + 'M' : tg >= 1000 ? '$' + (tg / 1000).toFixed(0) + 'K' : '$' + Math.round(tg);

  const filtered = filter === 'All' ? projects : projects.filter(p => p.status === filter);
  const dateCols = getDateCols(filter);
  const n = dateCols.length;
  const totalCols = 8 + n;

  if (loading) return <div style={{ background: BG, height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: MUTED, fontFamily: 'system-ui' }}>Loading...</div>;
  if (error) return <div style={{ background: BG, height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontFamily: 'system-ui' }}>{error}</div>;

  return (
    <div style={{ background: BG, minHeight: '100vh', color: TEXT, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>

      {/* Header */}
      <div style={{ borderBottom: '1px solid ' + BORD, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 3, height: 22, background: ACCENT, borderRadius: 2 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: '.06em' }}>R&R FABRICATION</div>
            <div style={{ color: '#444', fontSize: 10, letterSpacing: '.12em' }}>PROJECT TRACKER</div>
          </div>
        </div>
        <button onClick={openAdd} style={{ ...BTN, background: ACCENT, color: '#fff', borderRadius: 6, padding: '7px 16px', fontWeight: 700 }}>+ New project</button>
      </div>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: BORD, borderBottom: '1px solid ' + BORD }}>
        {[
          { label: 'Active backlog', val: blStr, sub: active.length + ' active projects', col: TEXT },
          { label: 'Active gross profit', val: gpStr, sub: 'Sell price minus cost', col: '#4ade80' },
          { label: 'Avg gross margin', val: fmtPct(avg), sub: 'Active weighted average', col: avg >= 20 ? '#4ade80' : avg >= 15 ? '#f59e0b' : '#ef4444' },
          { label: 'Bids outstanding', val: bids.length, sub: 'Bidding + Submitted', col: TEXT },
        ].map(m => (
          <div key={m.label} style={{ background: SURF, padding: '14px 18px' }}>
            <div style={{ color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 5 }}>{m.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: m.col, letterSpacing: '-.02em' }}>{m.val}</div>
            <div style={{ color: '#444', fontSize: 11, marginTop: 3 }}>{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '0 20px', borderBottom: '1px solid ' + BORD }}>
        {['All', ...STAT_KEYS].map(s => {
          const isA = filter === s, c = s === 'All' ? ACCENT : sc(s);
          const cnt = s === 'All' ? projects.length : projects.filter(p => p.status === s).length;
          return (
            <button key={s} onClick={() => setFilter(s)} style={{ ...BTN, background: isA ? c : 'transparent', color: isA ? '#fff' : c, border: '1px solid ' + (isA ? 'transparent' : c + '44'), borderBottom: 'none', borderRadius: '5px 5px 0 0', padding: '6px 10px', fontSize: 11, fontWeight: isA ? 700 : 400, marginTop: 8, whiteSpace: 'nowrap', opacity: cnt === 0 && !isA ? 0.3 : 1, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {s}<span style={{ background: isA ? 'rgba(255,255,255,.22)' : BORD2, borderRadius: 10, padding: '0 5px', fontSize: 10, fontWeight: 700 }}>{cnt}</span>
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', padding: '0 20px 40px' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '60px 0', textAlign: 'center', color: '#444' }}>
            {filter === 'All' ? <span>No projects yet. Click <strong style={{ color: TEXT }}>+ New project</strong> to add one.</span> : 'No projects in this status.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: n === 3 ? '18%' : n === 1 ? '25%' : '21%' }} />
              <col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '7%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '13%' }} />
              {dateCols.map((_, i) => <col key={i} style={{ width: n === 3 ? '7%' : n === 1 ? '10%' : '8%' }} />)}
              <col style={{ width: '9%' }} /><col style={{ width: '7%' }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid ' + BORD2 }}>
                {['Project', 'Sell price', 'Our cost', 'Gross profit', 'Margin', 'Status', ...dateCols.map(c => c.label), 'PM', ''].map(h => (
                  <th key={h} style={{ padding: '9px 10px', textAlign: 'left', color: '#444', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const gpv = gpCalc(p), gmv = gmCalc(p), c = sc(p.status);
                const dl = p.deliveries || [], hasDl = dl.length > 0;
                const isExp = expanded.has(p.id);
                const doneCnt = dl.filter(d => d.done).length;
                const dlColor = doneCnt === dl.length ? '#22c55e' : doneCnt > 0 ? '#06b6d4' : MUTED;
                return [
                  <tr key={p.id} style={{ borderBottom: isExp ? 'none' : '1px solid #1e1e1e' }}>
                    <td style={{ padding: '9px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                        {hasDl
                          ? <button onClick={() => toggleExpand(p.id)} style={{ ...BTN, background: 'transparent', color: isExp ? '#888' : '#444', fontSize: 10, padding: '2px 4px 0 0', lineHeight: 1, flexShrink: 0 }}>{isExp ? '▼' : '▶'}</button>
                          : <span style={{ width: 14, display: 'inline-block', flexShrink: 0 }} />}
                        <div style={{ minWidth: 0 }}>
                          {p.jobNumber && <div style={{ color: ACCENT, fontSize: 10, fontWeight: 700, letterSpacing: '.06em', marginBottom: 1 }}>#{p.jobNumber}</div>}
                          <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.name}{hasDl && <span style={{ fontSize: 10, color: dlColor, marginLeft: 6, fontWeight: 600 }}>{doneCnt}/{dl.length}</span>}
                          </div>
                          <div style={{ color: '#444', fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.customer}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '9px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtV(p.sellPrice)}</td>
                    <td style={{ padding: '9px 10px', color: DIM, whiteSpace: 'nowrap' }}>{fmtV(p.cost)}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 700, color: gpv > 0 ? '#4ade80' : '#ef4444', whiteSpace: 'nowrap' }}>{fmtV(gpv)}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 700, color: gmv >= 20 ? '#4ade80' : gmv >= 15 ? '#f59e0b' : '#ef4444', whiteSpace: 'nowrap' }}>{fmtPct(gmv)}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <select value={p.status} onChange={e => quickStatus(p.id, e.target.value)} style={{ background: c + '22', color: c, border: '1px solid ' + c + '55', borderRadius: 4, padding: '3px 7px', fontSize: 11, fontWeight: 700, cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}>
                        {STAT_KEYS.map(s => <option key={s} value={s} style={{ background: SURF, color: TEXT }}>{s}</option>)}
                      </select>
                    </td>
                    {dateCols.map(dc => <td key={dc.key} style={{ padding: '9px 10px', color: '#666', whiteSpace: 'nowrap' }}>{fmtD(p[dc.key])}</td>)}
                    <td style={{ padding: '9px 10px', color: '#666', fontSize: 11, whiteSpace: 'nowrap' }}>{p.pm || '--'}</td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => openEdit(p.id)} style={{ ...BTN, background: '#2a2a2a', color: '#888', borderRadius: 4, padding: '4px 9px', marginRight: 3 }}>Edit</button>
                      <button onClick={() => setDelTarget(p.id)} style={{ ...BTN, background: 'transparent', color: '#ef444455', border: '1px solid #ef444433', borderRadius: 4, padding: '4px 9px' }}>Del</button>
                    </td>
                  </tr>,
                  ...(isExp && hasDl ? dl.map((d, di) => (
                    <tr key={p.id + '-d' + di} style={{ background: '#0a0a0a', borderBottom: di === dl.length - 1 ? '2px solid ' + BORD : '1px solid #161616' }}>
                      <td colSpan={totalCols} style={{ padding: '7px 10px 7px 36px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <input type="checkbox" checked={d.done} onChange={e => toggleDelivery(p.id, di, e.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#22c55e', flexShrink: 0 }} />
                          <span style={{ color: d.done ? '#444' : '#999', fontSize: 12, textDecoration: d.done ? 'line-through' : 'none', flex: 1 }}>
                            {d.date && <span style={{ color: d.done ? '#444' : '#555', marginRight: 8, fontSize: 11 }}>{fmtD(d.date)}</span>}
                            {d.desc || '(no description)'}
                          </span>
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: d.done ? '#22c55e' : '#444' }}>{d.done ? 'DELIVERED' : 'PENDING'}</span>
                        </div>
                      </td>
                    </tr>
                  )) : [])
                ];
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      {modal && (
        <ProjectModal
          key={modal.project.id}
          initialForm={modal.project}
          initialDeliveries={(modal.project.deliveries || []).map(d => ({ ...d }))}
          mode={modal.mode}
          onSave={handleSave}
          onClose={() => setModal(null)}
          saving={saving}
        />
      )}
      {delTarget && <DeleteConfirm onConfirm={handleDelete} onCancel={() => setDelTarget(null)} />}
    </div>
  );
}
