import { useState, useEffect, useCallback } from 'react';

const STATUS_COLORS = {
  'Bidding': '#3b82f6', 'Submitted': '#a855f7', 'Awarded': '#22c55e', 'Purchasing': '#f59e0b',
  'In Fabrication': '#f97316', 'Ready for Galvanizing/Paint': '#14b8a6', 'In Galvanizing': '#0d9488',
  'In Paint': '#7c3aed', 'Shipping': '#06b6d4', 'Field/Erection': '#84cc16',
  'Completed': '#6b7280', 'Lost/On Hold': '#ef4444',
};
const STATUSES = Object.keys(STATUS_COLORS);
const DRAWING = ['N/A', 'Not Started', 'In Progress', 'Approved', 'Revision Needed'];
const CO_STATUS = ['Pending', 'Approved', 'Paid'];
const PAYAPP_STATUS = ['Draft', 'Submitted', 'Approved', 'Paid'];
const ACTIVE_FAB = ['In Fabrication', 'Ready for Galvanizing/Paint', 'In Galvanizing', 'In Paint', 'Shipping', 'Field/Erection'];
const PMS = ['Joe Jenkins', 'Steve Moskowitz', 'Tanja', 'Unassigned'];
const ROLE_LABEL = { super_admin: 'Super Admin', admin: 'Admin', accounting: 'Accounting', pm: 'PM', shop: 'Shop' };

const can = {
  editProject: r => ['super_admin', 'admin', 'pm'].includes(r),
  editCO: r => ['super_admin', 'admin', 'accounting', 'pm'].includes(r),
  editPayApp: r => ['super_admin', 'admin', 'accounting'].includes(r),
  upload: () => true,
  seeSettings: r => ['super_admin', 'admin'].includes(r),
};

const fmt$ = v => (v === null || v === undefined || v === '' || isNaN(v)) ? '—' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtK = v => { const n = parseFloat(v); if (isNaN(n)) return '—'; if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(0) + 'K'; return '$' + Math.round(n); };
const fmtDate = d => d ? new Date((typeof d === 'string' ? d.slice(0, 10) : d) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const gmColor = gm => gm >= 20 ? 'g' : gm >= 15 ? 'a' : 'r';

const api = {
  get: u => fetch(u).then(r => r.json()),
  send: (m, u, b) => fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Request failed'); return r.json().catch(() => ({})); }),
};

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0c0c0c;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px 60px}
.top{position:sticky;top:0;z-index:20;background:#0c0c0c;border-bottom:1px solid #252525}
.topin{max-width:1240px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.logo{font-weight:800;font-size:18px}.logo span{color:#e85d04}
.spacer{flex:1}
.nav{display:flex;gap:4px}
.navbtn{background:transparent;color:#999;border:1px solid transparent;border-radius:7px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer}
.navbtn:hover{color:#ddd;background:#141414}
.navbtn.on{color:#fff;background:#1d1d1d;border-color:#2e2e2e}
.badge{display:inline-block;min-width:18px;text-align:center;background:#ef4444;color:#fff;font-size:10px;font-weight:800;border-radius:20px;padding:1px 6px;margin-left:5px}
.who{color:#777;font-size:12px}
select,input,textarea{font-family:inherit;font-size:13px;background:#1a1a1a;color:#e8e8e8;border:1px solid #2e2e2e;border-radius:6px;padding:7px 9px;outline:none}
select:focus,input:focus,textarea:focus{border-color:#e85d04}
button{font-family:inherit;cursor:pointer;border:none;border-radius:6px;padding:8px 14px;font-size:13px;font-weight:600}
.btn-pri{background:#e85d04;color:#fff}.btn-ghost{background:transparent;color:#aaa;border:1px solid #2e2e2e}.btn-sm{padding:4px 10px;font-size:12px}
button:disabled{opacity:.35;cursor:not-allowed}
.perm{font-size:12.5px;color:#bbb;background:#141414;border:1px solid #252525;border-left:3px solid #e85d04;border-radius:6px;padding:9px 13px;margin:16px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}
.stat{background:#141414;border:1px solid #252525;border-radius:10px;padding:14px 16px}
.stat .l{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.stat .v{font-size:22px;font-weight:800;margin-top:5px}.stat .s{color:#555;font-size:11px;margin-top:3px}
.groupbar{display:flex;gap:6px;margin:14px 0 4px;flex-wrap:wrap}
.gt{background:#141414;border:1px solid #2e2e2e;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;color:#aaa;cursor:pointer}.gt.on{background:#e85d04;color:#fff;border-color:transparent}
table{width:100%;border-collapse:collapse;margin-top:14px}
th{text-align:left;color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:8px 10px;border-bottom:1px solid #252525;font-weight:600}
td{padding:10px;border-bottom:1px solid #1a1a1a;font-size:13px}
tr.row:hover td{background:#141414;cursor:pointer}
tfoot td{border-top:1px solid #2e2e2e;border-bottom:none;font-weight:700}
.muted{color:#666}.num{font-variant-numeric:tabular-nums}.right{text-align:right}
.g{color:#4ade80}.a{color:#f59e0b}.r{color:#ef4444}
.pill{display:inline-block;padding:2px 7px;border-radius:20px;font-size:11px;font-weight:700}
.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px}
.back{color:#888;font-size:13px;margin:18px 0 6px;display:inline-block;cursor:pointer}
.dhead{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:8px}.dhead h1{font-size:22px;margin:0}
.joblabel{color:#e85d04;font-size:11px;font-weight:700;letter-spacing:.06em}
.card{background:#141414;border:1px solid #252525;border-radius:10px;padding:16px;margin:14px 0}
.card h3{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#999;display:flex;justify-content:space-between;align-items:center}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
.kv .k{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.kv .v{font-size:18px;font-weight:700;margin-top:3px}
.tl{list-style:none;margin:0;padding:0}.tl li{padding:8px 0 8px 18px;border-left:2px solid #2e2e2e;position:relative}.tl li:before{content:'';position:absolute;left:-6px;top:13px;width:10px;height:10px;border-radius:50%;background:#e85d04}.tl .when{color:#666;font-size:11px}
.li{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1a1a1a}.li:last-child{border-bottom:none}.li .grow{flex:1}
.empty{color:#555;font-size:12.5px;padding:8px 0}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:50}
.modal{background:#161616;border:1px solid #2e2e2e;border-radius:12px;padding:22px;width:480px;max-width:92vw;max-height:88vh;overflow:auto}
.modal h2{margin:0 0 16px;font-size:16px}
.field{margin-bottom:12px}.field label{display:block;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.field input,.field select,.field textarea{width:100%}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.calc{background:#101010;border:1px solid #252525;border-radius:8px;padding:10px 12px;margin-top:4px;font-size:12.5px}.calc div{display:flex;justify-content:space-between;padding:2px 0}.calc .tot{border-top:1px solid #2e2e2e;margin-top:5px;padding-top:6px;font-weight:800;color:#4ade80}
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
.note{color:#777;font-size:12px}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.authbox{background:#141414;border:1px solid #252525;border-radius:12px;padding:28px;width:380px;max-width:92vw}
.authbox h1{font-size:20px;margin:0 0 4px}.authbox p{color:#888;font-size:13px;margin:0 0 18px}
.err{color:#ef4444;font-size:12.5px;margin:8px 0}
`;

function statusPill(s) { const c = STATUS_COLORS[s] || '#888'; return <span className="pill" style={{ background: c + '22', color: c, border: '1px solid ' + c + '55' }}>{s}</span>; }
function tagColor(map, s) { const c = map[s] || '#888'; return <span className="tag" style={{ background: c + '22', color: c }}>{s}</span>; }
const coTag = s => tagColor({ Pending: '#f59e0b', Approved: '#22c55e', Paid: '#4ade80' }, s);
const payTag = s => tagColor({ Draft: '#888', Submitted: '#a855f7', Approved: '#22c55e', Paid: '#4ade80' }, s);

// ---------- AUTH SCREENS ----------
function Splash() { return <div className="center"><div className="who">Loading…</div></div>; }

function AuthScreen({ mode, onDone }) {
  const setup = mode === 'setup';
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.send('POST', setup ? '/api/auth/setup' : '/api/auth/login', f);
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="center"><div className="authbox">
      <h1>R&R <span style={{ color: '#e85d04' }}>Fabrication</span></h1>
      <p>{setup ? 'Create the first administrator account.' : 'Sign in to the project tracker.'}</p>
      {setup && <div className="field"><label>Your name</label><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>}
      <div className="field"><label>Email</label><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      <div className="field"><label>Password</label><input type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      {err && <div className="err">{err}</div>}
      <button className="btn-pri" style={{ width: '100%', marginTop: 6 }} disabled={busy} onClick={submit}>{busy ? 'Please wait…' : setup ? 'Create account & sign in' : 'Sign in'}</button>
    </div></div>
  );
}

// ---------- MODAL HELPERS ----------
function Modal({ children, onClose }) {
  return <div className="ov" onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal">{children}</div></div>;
}

const blankProject = () => ({ jobNumber: '', name: '', customer: '', sellPrice: '', cost: '', status: 'Bidding', drawingStatus: 'N/A', pm: 'Joe Jenkins', bidDueDate: '', awardDate: '', fabStartDate: '', galvSendDate: '', galvReturnDate: '', paintSendDate: '', paintCompleteDate: '', notes: '', deliveries: [] });

function ProjectModal({ initial, onClose, onSaved }) {
  const [p, setP] = useState({ ...blankProject(), ...initial });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = k => e => setP({ ...p, [k]: e.target.value });
  const gp = (parseFloat(p.sellPrice) || 0) - (parseFloat(p.cost) || 0);
  const gm = parseFloat(p.sellPrice) > 0 ? gp / parseFloat(p.sellPrice) * 100 : 0;
  const save = async () => {
    if (!p.name) { setErr('Project name is required'); return; }
    setBusy(true); setErr(null);
    try {
      if (p.id) await api.send('PUT', '/api/projects/' + p.id, p);
      else await api.send('POST', '/api/projects', p);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return <Modal onClose={onClose}>
    <h2>{p.id ? 'Edit project' : 'New project'}</h2>
    <div className="row2">
      <div className="field"><label>Job #</label><input value={p.jobNumber} onChange={set('jobNumber')} /></div>
      <div className="field"><label>Project name</label><input value={p.name} onChange={set('name')} /></div>
    </div>
    <div className="row2">
      <div className="field"><label>Customer / GC</label><input value={p.customer} onChange={set('customer')} /></div>
      <div className="field"><label>Status</label><select value={p.status} onChange={set('status')}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>
    </div>
    <div className="row2">
      <div className="field"><label>PM</label><select value={p.pm} onChange={set('pm')}>{PMS.map(s => <option key={s}>{s}</option>)}</select></div>
      <div className="field"><label>Drawing status</label><select value={p.drawingStatus} onChange={set('drawingStatus')}>{DRAWING.map(s => <option key={s}>{s}</option>)}</select></div>
    </div>
    <div className="row2">
      <div className="field"><label>Original contract ($)</label><input type="number" value={p.sellPrice} onChange={set('sellPrice')} /></div>
      <div className="field"><label>Our cost ($)</label><input type="number" value={p.cost} onChange={set('cost')} /></div>
    </div>
    <div className="calc"><div><span>Gross profit</span><span className="num">{fmt$(gp)}</span></div><div><span>Gross margin</span><span className={'num ' + gmColor(gm)}>{gm.toFixed(1)}%</span></div></div>
    <div className="row2" style={{ marginTop: 12 }}>
      <div className="field"><label>Bid due</label><input type="date" value={p.bidDueDate || ''} onChange={set('bidDueDate')} /></div>
      <div className="field"><label>Award date</label><input type="date" value={p.awardDate || ''} onChange={set('awardDate')} /></div>
    </div>
    <div className="row2">
      <div className="field"><label>Fab start</label><input type="date" value={p.fabStartDate || ''} onChange={set('fabStartDate')} /></div>
      <div className="field"><label>Galv send</label><input type="date" value={p.galvSendDate || ''} onChange={set('galvSendDate')} /></div>
    </div>
    <div className="field"><label>Notes</label><textarea rows="2" value={p.notes} onChange={set('notes')} /></div>
    {err && <div className="err">{err}</div>}
    <div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-pri" disabled={busy} onClick={save}>{p.id ? 'Save' : 'Create'}</button></div>
  </Modal>;
}

// ---------- DASHBOARD ----------
const GROUPS = {
  All: ps => ps,
  Active: ps => ps.filter(p => !['Completed', 'Lost/On Hold'].includes(p.status)),
  Completed: ps => ps.filter(p => p.status === 'Completed'),
  'Lost/On Hold': ps => ps.filter(p => p.status === 'Lost/On Hold'),
};

function Dashboard({ user, onOpen }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState('Active');
  const [modal, setModal] = useState(null);
  const load = useCallback(() => api.get('/api/projects').then(d => { setProjects(d); setLoading(false); }), []);
  useEffect(() => { load(); }, [load]);

  const active = GROUPS.Active(projects);
  const totalBacklog = active.reduce((s, p) => s + (Number(p.sellPrice) || 0), 0);
  let num = 0, den = 0; active.forEach(p => { const sp = Number(p.sellPrice) || 0, gm = sp > 0 ? (sp - (Number(p.cost) || 0)) / sp * 100 : 0; num += gm * sp; den += sp; });
  const avgGM = den ? num / den : 0;
  const list = GROUPS[group](projects);
  const editor = can.editProject(user.role);

  const quickStatus = async (p, status) => { try { await api.send('PUT', '/api/projects/' + p.id, { ...p, status }); load(); } catch (e) { alert(e.message); } };

  return <div className="wrap">
    {loading ? <div className="who" style={{ marginTop: 30 }}>Loading projects…</div> : <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Projects</h1><div className="spacer" />
        {editor && <button className="btn-pri" onClick={() => setModal({ mode: 'add', project: blankProject() })}>+ New project</button>}
      </div>
      <div className="stats">
        <div className="stat"><div className="l">Active jobs</div><div className="v">{active.length}</div><div className="s">of {projects.length} total</div></div>
        <div className="stat"><div className="l">Active backlog</div><div className="v num">{fmtK(totalBacklog)}</div><div className="s">contract sum</div></div>
        <div className="stat"><div className={'v num ' + gmColor(avgGM)} style={{ fontSize: 22, fontWeight: 800 }}>{avgGM.toFixed(1)}%</div><div className="l">Avg gross margin</div><div className="s">weighted</div></div>
      </div>
      <div className="groupbar">{Object.keys(GROUPS).map(g => <button key={g} className={'gt' + (group === g ? ' on' : '')} onClick={() => setGroup(g)}>{g} <span style={{ opacity: .7 }}>{GROUPS[g](projects).length}</span></button>)}</div>
      <table><thead><tr><th>Project</th><th>Contract</th><th>Margin</th><th>Status</th><th>Deliveries</th><th>PM</th></tr></thead>
        <tbody>{list.length ? list.map(p => {
          const sp = Number(p.sellPrice) || 0, gm = sp > 0 ? (sp - (Number(p.cost) || 0)) / sp * 100 : 0;
          const done = (p.deliveries || []).filter(d => d.done).length;
          return <tr key={p.id} className="row" onClick={() => onOpen(p.id)}>
            <td>{p.jobNumber && <div className="joblabel">#{p.jobNumber}</div>}<div style={{ fontWeight: 700 }}>{p.name}</div><div className="muted" style={{ fontSize: 12 }}>{p.customer}</div></td>
            <td className="num">{fmtK(sp)}</td><td className={'num ' + gmColor(gm)}>{gm.toFixed(1)}%</td>
            <td onClick={e => e.stopPropagation()}>{editor ? <select value={p.status} onChange={e => quickStatus(p, e.target.value)} style={{ fontSize: 11, padding: '3px 6px' }}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select> : statusPill(p.status)}</td>
            <td className="muted">{(p.deliveries || []).length ? done + '/' + p.deliveries.length + ' shipped' : '—'}</td>
            <td className="muted">{p.pm || '—'}</td>
          </tr>;
        }) : <tr><td colSpan="6" className="empty">No projects in this view.</td></tr>}</tbody>
      </table>
    </>}
    {modal && <ProjectModal initial={modal.project} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
  </div>;
}

// ---------- PROJECT DETAIL ----------
function payAppRows(rows) {
  const apps = [...rows].sort((a, b) => a.applicationNumber - b.applicationNumber);
  return apps; // server already computed currentPaymentDue etc.
}

function Detail({ id, user, onBack }) {
  const [p, setP] = useState(null);
  const [hist, setHist] = useState([]);
  const [cos, setCos] = useState([]);
  const [invs, setInvs] = useState([]);
  const [docs, setDocs] = useState([]);
  const [modal, setModal] = useState(null);
  const load = useCallback(async () => {
    const all = await api.get('/api/projects');
    setP(all.find(x => x.id === id) || null);
    setHist(await api.get('/api/projects/' + id + '/stage-history'));
    setCos(await api.get('/api/projects/' + id + '/change-orders'));
    setInvs(await api.get('/api/projects/' + id + '/invoices'));
    setDocs(await api.get('/api/projects/' + id + '/documents'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (!p) return <div className="wrap"><div className="who" style={{ marginTop: 30 }}>Loading…</div></div>;

  const approvedCO = cos.filter(c => c.status === 'Approved' || c.status === 'Paid').reduce((s, c) => s + Number(c.amount || 0), 0);
  const contractSum = (Number(p.sellPrice) || 0) + approvedCO;
  const last = invs[invs.length - 1];
  const billed = last ? Number(last.workCompletedToDate) : 0;
  const retHeld = last ? Number(last.retainageHeld) : 0;
  const totalPaid = invs.reduce((s, a) => s + Number(a.amountPaid || 0), 0);
  const gp = contractSum - (Number(p.cost) || 0);
  const gm = contractSum > 0 ? gp / contractSum * 100 : 0;
  const eP = can.editProject(user.role), eC = can.editCO(user.role), eI = can.editPayApp(user.role);

  return <div className="wrap">
    <span className="back" onClick={onBack}>← Back to projects</span>
    <div className="dhead">
      <div>{p.jobNumber && <div className="joblabel">#{p.jobNumber}</div>}<h1>{p.name}</h1><div className="muted">{p.customer} · PM {p.pm || '—'}</div></div>
      <div className="spacer" />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{eP ? <select value={p.status} onChange={async e => { await api.send('PUT', '/api/projects/' + p.id, { ...p, status: e.target.value }); load(); }}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select> : statusPill(p.status)}
        {eP && <button className="btn-ghost btn-sm" onClick={() => setModal({ t: 'project', data: p })}>Edit</button>}</div>
    </div>

    <div className="card"><h3>Billing &amp; retainage (live)</h3>
      <div className="grid2">
        <div className="kv"><div className="k">Contract sum</div><div className="v num">{fmt$(contractSum)}</div></div>
        <div className="kv"><div className="k">Billed to date</div><div className="v num">{fmt$(billed)}</div></div>
        <div className="kv"><div className="k">Retainage held</div><div className="v num">{fmt$(retHeld)}</div></div>
        <div className="kv"><div className="k">Net paid</div><div className="v num">{fmt$(totalPaid)}</div></div>
        <div className="kv"><div className="k">Balance to finish</div><div className="v num">{fmt$(contractSum - billed)}</div></div>
        <div className="kv"><div className="k">Gross margin</div><div className={'v num ' + gmColor(gm)}>{gm.toFixed(1)}%</div></div>
      </div>
      <div className="note" style={{ marginTop: 10 }}>Contract sum = original {fmt$(p.sellPrice)} + approved change orders.</div>
    </div>

    <div className="card"><h3>Stage history</h3>
      <ul className="tl">{hist.length ? hist.map((h, i) => <li key={i}><b>{h.status}</b><div className="when">{fmtDate(h.changedAt)}{h.changedBy ? ' · ' + h.changedBy : ''}</div></li>) : <div className="empty">No history yet.</div>}</ul>
    </div>

    <div className="card"><h3>Pay applications {eI ? <button className="btn-pri btn-sm" onClick={() => setModal({ t: 'payapp' })}>+ Add pay app</button> : <span className="note">read-only</span>}</h3>
      {invs.length ? <table><thead><tr><th>App #</th><th>Period</th><th className="right">Completed</th><th className="right">Retainage</th><th className="right">Due</th><th className="right">Paid</th><th>Status</th><th /></tr></thead>
        <tbody>{invs.map(a => <tr key={a.id}>
          <td>#{a.applicationNumber}</td><td className="muted">{fmtDate(a.periodEnd)}</td>
          <td className="right num">{fmt$(a.workCompletedToDate)}</td><td className="right num">{fmt$(a.retainageHeld)}</td>
          <td className="right num">{fmt$(a.currentPaymentDue)}</td><td className={'right num ' + (a.amountPaid ? 'g' : '')}>{a.amountPaid ? fmt$(a.amountPaid) : '—'}</td>
          <td>{payTag(a.status)}</td>
          <td className="right">{eI && a.status !== 'Paid' && !a.amountPaid && <button className="btn-ghost btn-sm" onClick={() => setModal({ t: 'payment', data: a })}>Record payment</button>}</td>
        </tr>)}</tbody></table> : <div className="empty">No pay apps yet.</div>}
    </div>

    <div className="card"><h3>Change orders {eC ? <button className="btn-pri btn-sm" onClick={() => setModal({ t: 'co' })}>+ Add C/O</button> : <span className="note">read-only</span>}</h3>
      {cos.length ? cos.map(c => <div className="li" key={c.id}><div className="grow"><b>{c.coNumber}</b> · {c.description}<br /><span className="muted" style={{ fontSize: 12 }}>submitted {fmtDate(c.submittedDate)}</span></div>
        <div className="num" style={{ minWidth: 90, textAlign: 'right', fontWeight: 700 }}>{fmt$(c.amount)}</div><div style={{ minWidth: 90, textAlign: 'right' }}>{coTag(c.status)}</div></div>) : <div className="empty">No change orders yet.</div>}
    </div>

    <div className="card"><h3>Documents {can.upload() ? <UploadBtn projectId={id} onDone={load} /> : null}</h3>
      {docs.length ? docs.map(f => <div className="li" key={f.id}><div className="grow">📄 {f.fileName} <span className="muted" style={{ fontSize: 12 }}>· {(f.fileSize / 1024).toFixed(0)} KB · {f.category}</span></div>
        <a className="btn-ghost btn-sm" style={{ textDecoration: 'none', display: 'inline-block' }} href={'/api/documents/' + f.id + '/download'}>Download</a></div>) : <div className="empty">No documents uploaded.</div>}
    </div>

    {modal && modal.t === 'project' && <ProjectModal initial={modal.data} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    {modal && modal.t === 'co' && <CoModal projectId={id} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    {modal && modal.t === 'payapp' && <PayAppModal projectId={id} prevRows={invs} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    {modal && modal.t === 'payment' && <PaymentModal inv={modal.data} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
  </div>;
}

function UploadBtn({ projectId, onDone }) {
  const [busy, setBusy] = useState(false);
  const onPick = async e => {
    const file = e.target.files[0]; if (!file) return;
    setBusy(true);
    const fd = new FormData(); fd.append('file', file); fd.append('category', 'general');
    try { await fetch('/api/projects/' + projectId + '/documents', { method: 'POST', body: fd }); onDone(); } catch (_) { alert('Upload failed'); }
    setBusy(false); e.target.value = '';
  };
  return <label className="btn-pri btn-sm" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : '+ Upload'}<input type="file" style={{ display: 'none' }} onChange={onPick} /></label>;
}

function CoModal({ projectId, onClose, onSaved }) {
  const [c, setC] = useState({ coNumber: '', description: '', amount: '', status: 'Pending', submittedDate: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const set = k => e => setC({ ...c, [k]: e.target.value });
  const save = async () => { setBusy(true); setErr(null); try { await api.send('POST', '/api/projects/' + projectId + '/change-orders', c); onSaved(); } catch (e) { setErr(e.message); setBusy(false); } };
  return <Modal onClose={onClose}><h2>Add change order</h2>
    <div className="field"><label>C/O number</label><input value={c.coNumber} onChange={set('coNumber')} placeholder="CO-01" /></div>
    <div className="field"><label>Description</label><input value={c.description} onChange={set('description')} /></div>
    <div className="field"><label>Amount ($) — negative for a credit</label><input type="number" value={c.amount} onChange={set('amount')} /></div>
    <div className="field"><label>Status</label><select value={c.status} onChange={set('status')}>{CO_STATUS.map(s => <option key={s}>{s}</option>)}</select></div>
    <div className="note">Only Approved or Paid C/Os increase the contract sum.</div>
    {err && <div className="err">{err}</div>}
    <div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-pri" disabled={busy} onClick={save}>Save</button></div>
  </Modal>;
}

function PayAppModal({ projectId, prevRows, onClose, onSaved }) {
  const nextNo = (prevRows.reduce((m, a) => Math.max(m, a.applicationNumber), 0)) + 1;
  const prevELR = prevRows.length ? Number(prevRows[prevRows.length - 1].earnedLessRetainage) : 0;
  const [a, setA] = useState({ applicationNumber: nextNo, periodEnd: '', workCompletedToDate: '', retainagePct: 10, status: 'Draft' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const set = k => e => setA({ ...a, [k]: e.target.value });
  const comp = parseFloat(a.workCompletedToDate) || 0, pct = parseFloat(a.retainagePct) || 0;
  const ret = comp * pct / 100, elr = comp - ret, due = elr - prevELR;
  const save = async () => { setBusy(true); setErr(null); try { await api.send('POST', '/api/projects/' + projectId + '/invoices', a); onSaved(); } catch (e) { setErr(e.message); setBusy(false); } };
  return <Modal onClose={onClose}><h2>Add pay application #{nextNo}</h2>
    <div className="field"><label>Period through</label><input type="date" value={a.periodEnd} onChange={set('periodEnd')} /></div>
    <div className="field"><label>Work completed &amp; stored to date ($)</label><input type="number" value={a.workCompletedToDate} onChange={set('workCompletedToDate')} /></div>
    <div className="field"><label>Retainage %</label><input type="number" value={a.retainagePct} onChange={set('retainagePct')} /></div>
    <div className="field"><label>Status</label><select value={a.status} onChange={set('status')}>{PAYAPP_STATUS.map(s => <option key={s}>{s}</option>)}</select></div>
    <div className="calc">
      <div><span>Completed to date</span><span className="num">{fmt$(comp)}</span></div>
      <div><span>Less retainage ({pct || 0}%)</span><span className="num">- {fmt$(ret)}</span></div>
      <div><span>Earned less retainage</span><span className="num">{fmt$(elr)}</span></div>
      <div><span>Less previous billings</span><span className="num">- {fmt$(prevELR)}</span></div>
      <div className="tot"><span>Current payment due</span><span className="num">{fmt$(due)}</span></div>
    </div>
    {err && <div className="err">{err}</div>}
    <div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-pri" disabled={busy} onClick={save}>Save</button></div>
  </Modal>;
}

function PaymentModal({ inv, onClose, onSaved }) {
  const [amt, setAmt] = useState(Math.round(Number(inv.currentPaymentDue) || 0));
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const save = async () => { setBusy(true); setErr(null); try { await api.send('POST', '/api/invoices/' + inv.id + '/payment', { amountPaid: amt, paidDate: date }); onSaved(); } catch (e) { setErr(e.message); setBusy(false); } };
  return <Modal onClose={onClose}><h2>Record payment — Pay App #{inv.applicationNumber}</h2>
    <div className="field"><label>Amount received ($)</label><input type="number" value={amt} onChange={e => setAmt(e.target.value)} /></div>
    <div className="field"><label>Payment date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
    {err && <div className="err">{err}</div>}
    <div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-pri" disabled={busy} onClick={save}>Save payment</button></div>
  </Modal>;
}

// ---------- BILLING ----------
function Billing() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/api/billing').then(setD); }, []);
  if (!d) return <div className="wrap"><div className="who" style={{ marginTop: 30 }}>Loading…</div></div>;
  return <div className="wrap">
    <h1 style={{ fontSize: 20, margin: '6px 0' }}>Billing &amp; receivables</h1>
    <div className="stats">
      <div className="stat"><div className="l">Billed to date</div><div className="v num">{fmtK(d.billedToDate)}</div></div>
      <div className="stat"><div className="l">Collected</div><div className="v num g">{fmtK(d.collected)}</div></div>
      <div className="stat"><div className="l">Outstanding A/R</div><div className="v num a">{fmtK(d.outstanding)}</div></div>
      <div className="stat"><div className="l">Overdue (&gt;{d.netDays}d)</div><div className={'v num ' + (d.overdue ? 'r' : '')}>{fmtK(d.overdue)}</div></div>
      <div className="stat"><div className="l">Retainage held</div><div className="v num">{fmtK(d.retainageHeld)}</div></div>
    </div>
    <div className="card"><h3>Awaiting payment</h3>
      <table><thead><tr><th>Project</th><th>Pay app</th><th>Submitted</th><th>Outstanding for</th><th className="right">Amount due</th></tr></thead>
        <tbody>{d.open.length ? d.open.map((o, i) => <tr key={i}><td>{o.jobNumber && <span className="joblabel">#{o.jobNumber} </span>}<b>{o.name}</b></td><td>#{o.applicationNumber}</td><td className="muted">{fmtDate(o.submittedDate)}</td><td className={o.overdue ? 'r' : 'num'}>{o.days} days{o.overdue ? ' · OVERDUE' : ''}</td><td className="right num" style={{ fontWeight: 700 }}>{fmt$(o.due)}</td></tr>) : <tr><td colSpan="5" className="empty">Nothing outstanding.</td></tr>}</tbody></table>
    </div>
    <div className="card"><h3>Payment history (paid)</h3>
      <table><thead><tr><th>Project</th><th>Pay app</th><th>Paid date</th><th className="right">Amount paid</th></tr></thead>
        <tbody>{d.paidHist.length ? d.paidHist.map((h, i) => <tr key={i}><td>{h.jobNumber && <span className="joblabel">#{h.jobNumber} </span>}<b>{h.name}</b></td><td>#{h.applicationNumber}</td><td className="muted">{fmtDate(h.paidDate)}</td><td className="right num g" style={{ fontWeight: 700 }}>{fmt$(h.amountPaid)}</td></tr>) : <tr><td colSpan="4" className="empty">No payments recorded yet.</td></tr>}</tbody></table>
    </div>
    <div className="card"><h3>May need billing</h3>
      <div className="note" style={{ margin: '-4px 0 10px' }}>Active jobs where the contract is ahead of what has been billed.</div>
      <table><thead><tr><th>Project</th><th>Status</th><th>Last billed</th><th className="right">Unbilled work</th></tr></thead>
        <tbody>{d.needsBilling.length ? d.needsBilling.map((n, i) => <tr key={i}><td>{n.jobNumber && <span className="joblabel">#{n.jobNumber} </span>}<b>{n.name}</b></td><td>{statusPill(n.status)}</td><td className="muted">{n.lastBilled ? fmtDate(n.lastBilled) : 'never billed'}</td><td className="right num" style={{ fontWeight: 700 }}>{fmt$(n.unbilled)}</td></tr>) : <tr><td colSpan="4" className="empty">No active jobs with unbilled work.</td></tr>}</tbody></table>
    </div>
  </div>;
}

// ---------- SETTINGS ----------
function Settings({ user }) {
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const load = useCallback(() => api.get('/api/users').then(setUsers), []);
  useEffect(() => { load(); }, [load]);
  return <div className="wrap">
    <h1 style={{ fontSize: 20, margin: '6px 0' }}>Settings</h1>
    <div className="card"><h3>Users &amp; roles <button className="btn-pri btn-sm" onClick={() => setModal(true)}>+ Add user</button></h3>
      <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>{users.map(u => <tr key={u.id}><td><b>{u.name}</b></td><td className="muted">{u.email}</td><td>{ROLE_LABEL[u.role]}</td><td>{u.active ? <span className="g">Active</span> : <span className="muted">Disabled</span>}</td></tr>)}</tbody></table>
      <div className="note" style={{ marginTop: 10 }}>Only one Super Admin exists. Admins manage everyone else. New users sign in with the temporary password you set, which they can change later.</div>
    </div>
    {modal && <AddUserModal onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />}
  </div>;
}

function AddUserModal({ onClose, onSaved }) {
  const [u, setU] = useState({ name: '', email: '', password: '', role: 'pm' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const set = k => e => setU({ ...u, [k]: e.target.value });
  const save = async () => { setBusy(true); setErr(null); try { await api.send('POST', '/api/users', u); onSaved(); } catch (e) { setErr(e.message); setBusy(false); } };
  return <Modal onClose={onClose}><h2>Add user</h2>
    <div className="field"><label>Name</label><input value={u.name} onChange={set('name')} /></div>
    <div className="field"><label>Email</label><input type="email" value={u.email} onChange={set('email')} /></div>
    <div className="field"><label>Temporary password</label><input value={u.password} onChange={set('password')} /></div>
    <div className="field"><label>Role</label><select value={u.role} onChange={set('role')}><option value="admin">Admin</option><option value="accounting">Accounting</option><option value="pm">PM</option><option value="shop">Shop</option></select></div>
    <div className="note">Super Admin cannot be assigned here.</div>
    {err && <div className="err">{err}</div>}
    <div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-pri" disabled={busy} onClick={save}>Add</button></div>
  </Modal>;
}

// ---------- MAIN ----------
function Main({ user, onLogout }) {
  const [view, setView] = useState({ name: 'projects' });
  const nav = (name) => setView({ name });
  return <>
    <div className="top"><div className="topin">
      <div className="logo">R&amp;R <span>Fabrication</span></div>
      <nav className="nav">
        <button className={'navbtn' + (view.name === 'projects' || view.name === 'detail' ? ' on' : '')} onClick={() => nav('projects')}>Projects</button>
        <button className={'navbtn' + (view.name === 'billing' ? ' on' : '')} onClick={() => nav('billing')}>Billing</button>
        {can.seeSettings(user.role) && <button className={'navbtn' + (view.name === 'settings' ? ' on' : '')} onClick={() => nav('settings')}>Settings</button>}
      </nav>
      <div className="spacer" />
      <span className="who">{user.name} · {ROLE_LABEL[user.role]}</span>
      <button className="btn-ghost btn-sm" onClick={onLogout}>Log out</button>
    </div></div>
    <div className="perm" style={{ maxWidth: 1240, margin: '16px auto', marginLeft: 'auto', marginRight: 'auto', width: 'calc(100% - 40px)' }}>
      Signed in as <b>{ROLE_LABEL[user.role]}</b>. {can.editProject(user.role) ? 'You can move stages and edit projects. ' : 'Projects are read-only for your role. '}
      {can.editPayApp(user.role) ? 'You can enter pay apps and record payments.' : 'Pay-app billing is read-only.'}
    </div>
    {view.name === 'projects' && <Dashboard user={user} onOpen={id => setView({ name: 'detail', id })} />}
    {view.name === 'detail' && <Detail id={view.id} user={user} onBack={() => nav('projects')} />}
    {view.name === 'billing' && <Billing />}
    {view.name === 'settings' && can.seeSettings(user.role) && <Settings user={user} />}
  </>;
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const reload = useCallback(() => api.get('/api/auth/status').then(setAuth), []);
  useEffect(() => { reload(); }, [reload]);
  const logout = async () => { await api.send('POST', '/api/auth/logout'); reload(); };
  return <>
    <style>{CSS}</style>
    {!auth ? <Splash /> : !auth.hasUsers ? <AuthScreen mode="setup" onDone={reload} /> : !auth.authenticated ? <AuthScreen mode="login" onDone={reload} /> : <Main user={auth.user} onLogout={logout} />}
  </>;
}
