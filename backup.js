// Nightly off-site backup to SharePoint.
//
// Each run uploads two files to one SharePoint folder:
//   rr-tracker-db-<time>.json.gz     every table in Postgres, as JSON
//   rr-tracker-files-<time>.zip      the /data volume (uploaded documents, pay apps)
// then deletes backups in that folder older than BACKUP_KEEP_DAYS (default 30).
// RESTORE.md explains how to load one back.
//
// Uses the same Microsoft Graph app sign-in as the rrfab-bid backend
// (lib/offsite_sharepoint.js there), with the same variable names:
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//   BACKUP_SP_SITE     e.g. rrfabrication.sharepoint.com:/sites/Operations
//   BACKUP_SP_FOLDER   default 'RR_Tracker_Backups'. Created if missing.
//   BACKUP_SP_LIBRARY  optional, a library other than the site's default one
//
// App-only sign-in on purpose: a user's token eventually expires without anyone
// noticing, which is the one thing a backup must not do.
//
// Pruning only ever touches files named rr-tracker-*, and only after the new
// backup uploaded, so a bad night never leaves the folder empty and a folder
// shared with something else is left alone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const archiver = require('archiver');
const { pool } = require('./migrate');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;   // Graph wants an upload session above 4 MB
const CHUNK = 10 * 320 * 1024;                 // 3.2 MB; must be a multiple of 320 KiB
const PREFIX = 'rr-tracker-';

const CFG = {
  site: (process.env.BACKUP_SP_SITE || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  folder: (process.env.BACKUP_SP_FOLDER || 'RR_Tracker_Backups').replace(/^\/+|\/+$/g, ''),
  library: process.env.BACKUP_SP_LIBRARY || '',
  tenant: process.env.AZURE_TENANT_ID || '',
  clientId: process.env.AZURE_CLIENT_ID || '',
  clientSecret: process.env.AZURE_CLIENT_SECRET || '',
  keepDays: Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '30', 10) || 30),
};
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
// Left out of the zip: the login-signing secret (anyone holding it could forge a
// login; without it a restore just signs everyone out once) and disk leftovers.
const SKIP_IN_ZIP = ['jwt_secret', 'lost+found', 'b2-backup-state.json', 'b2-backup-state.json.tmp'];

function missingConfig() {
  const m = [];
  if (!CFG.site) m.push('BACKUP_SP_SITE');
  if (!CFG.tenant) m.push('AZURE_TENANT_ID');
  if (!CFG.clientId) m.push('AZURE_CLIENT_ID');
  if (!CFG.clientSecret) m.push('AZURE_CLIENT_SECRET');
  if (!process.env.DATABASE_URL) m.push('DATABASE_URL');
  return m;
}
const isConfigured = () => missingConfig().length === 0;

// ---- Graph ----
async function timedFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 120000);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

let token = null, tokenExpires = 0;
async function getToken() {
  if (token && tokenExpires > Date.now() + 60000) return token;
  const res = await timedFetch('https://login.microsoftonline.com/' + CFG.tenant + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.clientId, client_secret: CFG.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
  }, 20000);
  if (!res.ok) throw new Error('Microsoft sign-in failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const d = await res.json();
  token = d.access_token; tokenExpires = Date.now() + (d.expires_in || 3600) * 1000;
  return token;
}

async function graph(pathOrUrl, opts = {}) {
  const t = await getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH_BASE + pathOrUrl;
  return timedFetch(url, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
}
async function graphFail(res, what) {
  return new Error(what + ': ' + res.status + ' ' + (await res.text()).slice(0, 300));
}

// Where we write, as a Graph path prefix. Looked up once per process.
let driveRoot = null;
async function getDriveRoot() {
  if (driveRoot) return driveRoot;
  const siteRes = await graph('/sites/' + CFG.site);
  if (!siteRes.ok) throw await graphFail(siteRes, 'Could not find the SharePoint site "' + CFG.site + '"');
  const siteId = (await siteRes.json()).id;
  if (!CFG.library) return (driveRoot = '/sites/' + siteId + '/drive');
  const dr = await graph('/sites/' + siteId + '/drives');
  if (!dr.ok) throw await graphFail(dr, 'Could not list document libraries');
  const drives = (await dr.json()).value || [];
  const hit = drives.find(d => String(d.name || '').toLowerCase() === CFG.library.toLowerCase());
  if (!hit) throw new Error('No document library named "' + CFG.library + '". Found: ' + drives.map(d => d.name).join(', '));
  return (driveRoot = '/drives/' + hit.id);
}

// Upload a local file. Graph creates the folder if it is not there yet.
async function uploadFile(localPath, name) {
  const root = await getDriveRoot();
  const itemPath = encodeURI(CFG.folder + '/' + name);
  const size = fs.statSync(localPath).size;
  if (size <= SIMPLE_UPLOAD_LIMIT) {
    const res = await graph(root + '/root:/' + itemPath + ':/content', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(localPath),
    });
    if (!res.ok) throw await graphFail(res, 'Upload of ' + name + ' failed');
    return size;
  }
  const s = await graph(root + '/root:/' + itemPath + ':/createUploadSession', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  if (!s.ok) throw await graphFail(s, 'Could not start upload of ' + name);
  const { uploadUrl } = await s.json();
  const fd = fs.openSync(localPath, 'r');
  try {
    for (let start = 0; start < size; start += CHUNK) {
      const len = Math.min(CHUNK, size - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      // The upload URL carries its own auth, so no bearer token here.
      const res = await timedFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(len), 'Content-Range': 'bytes ' + start + '-' + (start + len - 1) + '/' + size },
        body: buf,
      });
      if (!res.ok) throw await graphFail(res, 'Upload of ' + name + ' stopped at byte ' + start);
    }
  } finally { fs.closeSync(fd); }
  return size;
}

// Delete our own backups older than keepDays. The date comes from the file name.
async function pruneOld() {
  const root = await getDriveRoot();
  const cutoff = Date.now() - CFG.keepDays * 86400000;
  let url = root + '/root:/' + encodeURI(CFG.folder) + ':/children?$select=id,name&$top=200';
  const old = [];
  while (url) {
    const res = await graph(url);
    if (!res.ok) throw await graphFail(res, 'Could not list the backup folder');
    const d = await res.json();
    for (const f of d.value || []) {
      const m = String(f.name || '').match(/^rr-tracker-(?:db|files)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\./);
      if (m && Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z') < cutoff) old.push(f);
    }
    url = d['@odata.nextLink'] || null;
  }
  for (const f of old) {
    const res = await graph(root + '/items/' + f.id, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await graphFail(res, 'Could not delete old backup ' + f.name);
  }
  return old.length;
}

// ---- Database export ----
// Every value comes back exactly as Postgres prints it (text), not converted to
// JavaScript numbers or dates. That keeps money, dates and times exact, and lets
// the restore hand each value straight back to Postgres.
const RAW = { getTypeParser: () => v => v };

async function dumpDatabase(outPath) {
  const client = await pool.connect();
  const out = { app: 'rrfab-project-tracker', format: 1, created_at: new Date().toISOString(), tables: {} };
  let rows = 0;
  try {
    // One read-only snapshot, so every table is from the same moment.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const t = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    for (const { table_name: name } of t.rows) {
      const r = await client.query({ text: 'SELECT * FROM "' + name.replace(/"/g, '""') + '"', types: RAW, rowMode: 'array' });
      out.tables[name] = { columns: r.fields.map(f => f.name), rows: r.rows };
      rows += r.rows.length;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
  fs.writeFileSync(outPath, zlib.gzipSync(Buffer.from(JSON.stringify(out))));
  return { tables: Object.keys(out.tables).length, rows };
}

// ---- /data volume ----
function zipDataDir(outPath) {
  return new Promise((resolve, reject) => {
    let files = 0;
    const output = fs.createWriteStream(outPath);
    const zip = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve({ files }));
    zip.on('entry', () => { files++; });
    zip.on('warning', e => console.error('[backup] zip warning: ' + e.message));
    zip.on('error', reject);
    zip.pipe(output);
    if (fs.existsSync(DATA_DIR)) {
      zip.glob('**/*', { cwd: DATA_DIR, dot: true, nodir: true, ignore: SKIP_IN_ZIP.flatMap(s => [s, s + '/**']) });
    }
    zip.finalize();
  });
}

// ---- One run ----
const state = { running: false, last: null };
const mb = n => (n / 1048576).toFixed(1) + ' MB';

async function runBackup(trigger) {
  if (state.running) return { ok: false, error: 'a backup is already running' };
  state.running = true;
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');   // 2026-09-25T07-00-00Z
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-backup-' + crypto.randomBytes(3).toString('hex') + '-'));
  const out = { at: new Date().toISOString(), trigger, ok: false };
  try {
    if (!isConfigured()) throw new Error('not configured. Missing: ' + missingConfig().join(', '));
    const dbName = PREFIX + 'db-' + stamp + '.json.gz';
    const zipName = PREFIX + 'files-' + stamp + '.zip';
    const db = await dumpDatabase(path.join(tmp, dbName));
    const vol = await zipDataDir(path.join(tmp, zipName));
    const bytes = (await uploadFile(path.join(tmp, dbName), dbName)) + (await uploadFile(path.join(tmp, zipName), zipName));
    let pruned = 0, pruneError = null;
    try { pruned = await pruneOld(); } catch (e) { pruneError = e.message; }
    Object.assign(out, { ok: true, tables: db.tables, rows: db.rows, files: vol.files, bytes, pruned, uploaded: [dbName, zipName] });
    console.log('[backup] ok: ' + db.tables + ' tables (' + db.rows + ' rows), ' + vol.files + ' files, ' + mb(bytes) +
      ' uploaded to ' + CFG.folder + (pruned ? ', ' + pruned + ' old backup file(s) removed' : '') +
      (pruneError ? '; could not clear old backups: ' + pruneError : ''));
  } catch (e) {
    out.error = e.message;
    console.error('[backup] FAILED (' + trigger + '): ' + e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    state.running = false;
    state.last = out;
  }
  return out;
}

module.exports = { runBackup, state, isConfigured, missingConfig, CFG, zipDataDir };
