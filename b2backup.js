'use strict';
// Nightly independent backup to Backblaze B2 (the disaster-recovery copy).
// Runs alongside the SharePoint backup in backup.js, which is left as it is.
//
// Each run, for every tier that is due (daily always; weekly on Mondays and
// monthly on the 1st, plus all three the very first time):
//   database/<tier>/rrfab-project-tracker_<db>_<YYYY-MM-DD>_<HHMM>UTC.dump   pg_dump custom format
//   database/<tier>/...manifest.json                                         sizes, checksums, row counts
//   files/<tier>/rrfab-project-tracker_files_<...>.zip                       the /data volume (uploads)
//   recovery/RECOVERY.md                                                     how to rebuild, no secrets
// all under B2_BACKUP_PREFIX (projects/rrfab-project-tracker/).
//
// A run only counts as good after every file is downloaded back, its checksum
// matches, and the downloaded dump is read back by pg_restore. Anything else
// logs "[b2-backup] BACKUP FAILED" and emails B2_BACKUP_ALERT_TO.
//
// This code never deletes anything in B2. Old copies expire through B2
// lifecycle rules on each tier's folder (daily 30 days, weekly 84, monthly 365),
// so the application key does not need delete rights.
//
// Same variable names and signing approach as rrfab-bid's lib/backblaze_backup.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024 * 1024;   // one object; keeps memory bounded. Past this, fail loudly and review.
const STALE_AFTER = 26 * 60 * 60 * 1000;
const APP = 'rrfab-project-tracker';
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();

class BackupError extends Error {}
const fail = m => { throw new BackupError(m); };

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const CFG = {
  enabled: process.env.B2_BACKUP_ENABLED === 'true',
  endpoint: process.env.B2_BACKUP_ENDPOINT || '',
  region: process.env.B2_BACKUP_REGION || '',
  bucket: process.env.B2_BACKUP_BUCKET || '',
  prefix: process.env.B2_BACKUP_PREFIX || 'projects/' + APP + '/',
  keyId: process.env.B2_BACKUP_KEY_ID || '',
  secret: process.env.B2_BACKUP_SECRET || '',
  utcTime: process.env.B2_BACKUP_UTC_TIME || '07:37',   // 3:37 AM EDT / 2:37 AM EST, after the SharePoint run
  alertTo: process.env.B2_BACKUP_ALERT_TO || '',
  alertFrom: process.env.B2_BACKUP_ALERT_FROM || '',
};

function missingConfig() {
  const m = [];
  for (const [k, v] of [['B2_BACKUP_ENDPOINT', CFG.endpoint], ['B2_BACKUP_REGION', CFG.region], ['B2_BACKUP_BUCKET', CFG.bucket],
    ['B2_BACKUP_KEY_ID', CFG.keyId], ['B2_BACKUP_SECRET', CFG.secret], ['DATABASE_URL', process.env.DATABASE_URL]]) if (!v) m.push(k);
  return m;
}
function validate() {
  const m = missingConfig();
  if (m.length) fail('not configured. Missing: ' + m.join(', '));
  if (!/^[a-z0-9-]+$/.test(CFG.region) || CFG.endpoint !== 'https://s3.' + CFG.region + '.backblazeb2.com') fail('B2 endpoint must match its HTTPS region endpoint');
  if (!/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/.test(CFG.bucket)) fail('Invalid B2 bucket name');
  if (!/^projects\/[a-z0-9_-]+\/$/.test(CFG.prefix)) fail('Use a project-specific B2 prefix like projects/' + APP + '/');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(CFG.utcTime)) fail('B2_BACKUP_UTC_TIME must be HH:MM in UTC');
}

// Which daily/weekly/monthly period "now" falls in. Weeks start Monday.
function periodsAt(now) {
  const due = new Date(now);
  const [h, mi] = CFG.utcTime.split(':').map(Number);
  due.setUTCHours(h, mi, 0, 0);
  if (due > now) due.setUTCDate(due.getUTCDate() - 1);
  const daily = due.toISOString().slice(0, 10);
  const monthly = daily.slice(0, 7);
  due.setUTCDate(due.getUTCDate() - (due.getUTCDay() + 6) % 7);
  return { daily, weekly: due.toISOString().slice(0, 10), monthly };
}

// ---- S3-compatible requests, signed by hand (AWS Signature v4) ----
function signedHeaders(method, url, body, now) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const u = new URL(url);
  const headers = { host: u.host, 'x-amz-content-sha256': sha256(body), 'x-amz-date': amzDate };
  if (method === 'PUT') headers['x-amz-server-side-encryption'] = 'AES256';
  const names = Object.keys(headers).sort();
  const canonical = [method, u.pathname, '', names.map(n => n + ':' + headers[n] + '\n').join(''), names.join(';'), sha256(body)].join('\n');
  const scope = date + '/' + CFG.region + '/s3/aws4_request';
  let key = hmac('AWS4' + CFG.secret, date);
  key = hmac(key, CFG.region); key = hmac(key, 's3'); key = hmac(key, 'aws4_request');
  headers.Authorization = 'AWS4-HMAC-SHA256 Credential=' + CFG.keyId + '/' + scope + ', SignedHeaders=' + names.join(';') +
    ', Signature=' + hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).toString('hex');
  if (method === 'PUT') { headers['Content-Length'] = String(body.length); headers['Content-Type'] = 'application/octet-stream'; }
  return headers;
}

async function request(method, key, body = Buffer.alloc(0), limit = MAX_BYTES) {
  const url = CFG.endpoint + '/' + CFG.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  const timeout = 30000 + Math.ceil((method === 'PUT' ? body.length : limit) / 1048576) * 2000;
  for (let attempt = 0; attempt < 3; attempt++) {
    let retry = true;
    try {
      const res = await fetch(url, {
        method, headers: signedHeaders(method, url, body, new Date()),
        body: method === 'PUT' ? body : undefined, redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        await res.body?.cancel();
        retry = res.status === 408 || res.status === 429 || res.status >= 500;
        fail('B2 ' + method + ' returned HTTP ' + res.status + (res.status === 403 ? ' (check the application key and its bucket/prefix)' : ''));
      }
      const chunks = []; let size = 0;
      for await (const c of res.body || []) {
        size += c.length;
        if (size > limit) { retry = false; fail('B2 response was larger than expected'); }
        chunks.push(c);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      if (!retry || attempt === 2) throw e instanceof BackupError ? e : new BackupError('B2 ' + method + ' network request failed or timed out');
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// Upload, download it back and compare. Returns the downloaded copy.
async function putVerified(key, buf) {
  await request('PUT', key, buf);
  const back = await request('GET', key, undefined, buf.length);
  if (sha256(back) !== sha256(buf)) fail('Downloaded copy of ' + key.split('/').pop() + ' did not match what was uploaded');
  return back;
}

// ---- local tools ----
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const why = err.code === 'ENOENT' ? cmd + ' is not installed on the server' : cmd + ' failed: ' + String(stderr || err.message).split('\n')[0].slice(0, 200);
        return reject(new BackupError(why.replace(/postgres(ql)?:\/\/[^\s]+/g, '<database url>')));
      }
      resolve(stdout);
    });
  });
}

async function dbInfo() {
  const { pool } = require('./migrate');
  const client = await pool.connect();
  try {
    const v = await client.query("SELECT current_database() AS db, current_setting('server_version') AS version");
    const t = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    const counts = {};
    for (const { table_name: n } of t.rows) counts[n] = Number((await client.query('SELECT COUNT(*)::bigint AS n FROM "' + n.replace(/"/g, '""') + '"')).rows[0].n);
    return { database: v.rows[0].db, serverVersion: v.rows[0].version, tableRowCounts: counts };
  } finally { client.release(); }
}

// ---- state (on the volume, so a redeploy does not repeat or forget a run) ----
const stateFile = path.join(DATA_DIR, 'b2-backup-state.json');
const state = {
  enabled: CFG.enabled, configured: false, running: false, scheduleUtc: CFG.utcTime,
  lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
  completedPeriods: {}, lastObjects: [], lastFailureAlertAt: null, lastRecoveryAlertAt: null, lastAlertError: null,
};
const destination = [CFG.endpoint, CFG.bucket, CFG.prefix].join('/');
let loaded = false;
function loadState() {
  if (loaded) return; loaded = true;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s.destination !== destination) return;
    for (const k of ['lastAttemptAt', 'lastSuccessAt', 'lastError', 'lastFailureAlertAt', 'lastRecoveryAlertAt']) if (s[k]) state[k] = s[k];
    if (s.completedPeriods && typeof s.completedPeriods === 'object') state.completedPeriods = s.completedPeriods;
    if (Array.isArray(s.lastObjects)) state.lastObjects = s.lastObjects;
    state.consecutiveFailures = Math.max(0, Number(s.consecutiveFailures) || 0);
  } catch (e) { if (e.code !== 'ENOENT') console.error('[b2-backup] saved schedule state unreadable; next run makes a fresh full set'); }
}
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ ...state, destination, running: false }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
  } catch (e) { console.error('[b2-backup] could not save schedule state: ' + e.message); }
}

// ---- alerts ----
async function alert(kind, problem) {
  if (!CFG.alertTo) { if (kind !== 'recovery') console.error('[b2-backup] no B2_BACKUP_ALERT_TO set, so nobody was emailed'); return; }
  const last = kind === 'recovery' ? state.lastRecoveryAlertAt : state.lastFailureAlertAt;
  if (last && Date.now() - Date.parse(last) < DAY) return;   // at most one of each per day
  const subject = kind === 'recovery' ? 'R&R Project Tracker: Backblaze backup is working again' : 'R&R Project Tracker: Backblaze backup needs attention';
  const text = [
    kind === 'recovery' ? 'The Backblaze backup ran and passed its checks.' : 'The nightly Backblaze backup did not complete. It will retry every 15 minutes.',
    'Last good backup (UTC): ' + (state.lastSuccessAt || 'none yet'),
    kind === 'recovery' ? '' : 'Problem: ' + (problem || state.lastError || 'unknown'),
    'Details are in the Railway logs for rrfab-project-tracker (search "b2-backup"). The SharePoint backup runs separately.',
  ].filter(Boolean).join('\n\n');
  try {
    await require('./mailer').sendMail({ to: CFG.alertTo, sender: CFG.alertFrom || undefined, subject, text, html: '<pre style="font-family:inherit">' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>' });
    state[kind === 'recovery' ? 'lastRecoveryAlertAt' : 'lastFailureAlertAt'] = new Date().toISOString();
    state.lastAlertError = null;
  } catch (e) {
    state.lastAlertError = 'alert email could not be sent';
    console.error('[b2-backup] alert email could not be sent: ' + String(e.message || e).slice(0, 200));
  }
  saveState();
}

// ---- one run ----
async function runOnce({ force = false, trigger = 'nightly' } = {}) {
  if (state.running) return { ok: false, error: 'a B2 backup is already running' };
  loadState();
  const at = new Date();
  let periods;
  try { validate(); state.configured = true; periods = periodsAt(at); }
  catch (e) { state.configured = false; if (!force) return { skipped: true }; periods = null; }
  const tiers = periods ? Object.keys(periods).filter(t => state.completedPeriods[t] !== periods[t]) : [];
  if (!force && !tiers.length) return { skipped: true };
  if (!force && state.consecutiveFailures && state.lastAttemptAt && at - Date.parse(state.lastAttemptAt) < 15 * 60 * 1000) return { skipped: true };
  if (!tiers.includes('daily')) tiers.unshift('daily');

  state.running = true;
  state.lastAttemptAt = at.toISOString();
  let tmp;
  try {
    validate();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-b2-'));
    const info = await dbInfo();
    const stamp = at.toISOString().slice(0, 10) + '_' + at.toISOString().slice(11, 16).replace(':', '') + 'UTC';
    const base = APP + '_' + info.database.replace(/[^A-Za-z0-9_-]/g, '') + '_' + stamp;

    // Portable dump: restores onto any PostgreSQL 18+ host with pg_restore.
    const dumpPath = path.join(tmp, base + '.dump');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, '--dbname', process.env.DATABASE_URL]);
    const dump = fs.readFileSync(dumpPath);
    if (dump.length > MAX_BYTES) fail('Database dump is over 512 MB; the backup setup needs a review');

    const zipPath = path.join(tmp, APP + '_files_' + stamp + '.zip');
    const vol = await require('./backup').zipDataDir(zipPath);
    const zip = fs.readFileSync(zipPath);
    if (zip.length > MAX_BYTES) fail('Uploaded-files archive is over 512 MB; the backup setup needs a review');

    const objects = [];
    for (const tier of tiers) {
      const dumpKey = CFG.prefix + 'database/' + tier + '/' + base + '.dump';
      const back = await putVerified(dumpKey, dump);
      // Prove the copy that is actually in B2 is a readable dump with our tables in it.
      const checkPath = path.join(tmp, 'check-' + tier + '.dump');
      fs.writeFileSync(checkPath, back);
      const list = await run('pg_restore', ['--list', checkPath]);
      for (const t of ['users', 'projects']) if (!new RegExp('TABLE DATA public ' + t + ' ').test(list)) fail('Downloaded dump is missing the ' + t + ' table');

      const filesKey = CFG.prefix + 'files/' + tier + '/' + path.basename(zipPath);
      await putVerified(filesKey, zip);

      const manifest = Buffer.from(JSON.stringify({
        format: 'pg_dump-custom-v1', app: APP, tier, period: periods[tier], startedAt: at.toISOString(), verifiedAt: new Date().toISOString(),
        dump: { key: dumpKey, bytes: dump.length, sha256: sha256(dump) },
        files: { key: filesKey, bytes: zip.length, sha256: sha256(zip), count: vol.files },
        database: info.database, serverVersion: info.serverVersion, tableRowCounts: info.tableRowCounts,
        restore: 'pg_restore --no-owner --no-privileges --clean --if-exists -d <target url> ' + path.basename(dumpKey),
      }, null, 2) + '\n');
      const manifestKey = CFG.prefix + 'database/' + tier + '/' + base + '.manifest.json';
      await putVerified(manifestKey, manifest);
      objects.push({ tier, dumpKey, filesKey, manifestKey, dumpBytes: dump.length, filesBytes: zip.length });
    }

    // Rebuild instructions live next to the backups in case GitHub is unreachable.
    const recovery = path.join(__dirname, 'RECOVERY.md');
    if (fs.existsSync(recovery)) await putVerified(CFG.prefix + 'recovery/RECOVERY.md', fs.readFileSync(recovery));

    const hadAlerted = state.lastFailureAlertAt && (!state.lastRecoveryAlertAt || state.lastFailureAlertAt > state.lastRecoveryAlertAt);
    Object.assign(state, { lastSuccessAt: new Date().toISOString(), lastError: null, consecutiveFailures: 0, lastObjects: objects,
      completedPeriods: { ...state.completedPeriods, ...Object.fromEntries(tiers.map(t => [t, periods[t]])) } });
    saveState();
    console.log('[b2-backup] VERIFIED (' + trigger + '): ' + tiers.join('+') + ', dump ' + (dump.length / 1048576).toFixed(2) + ' MB, ' +
      vol.files + ' files ' + (zip.length / 1048576).toFixed(2) + ' MB, ' + Object.keys(info.tableRowCounts).length + ' tables');
    if (hadAlerted) await alert('recovery');
    return { ok: true, tiers, objects };
  } catch (e) {
    state.lastError = e instanceof BackupError ? e.message : 'backup step failed: ' + String(e.message || e).slice(0, 200).replace(/postgres(ql)?:\/\/[^\s]+/g, '<database url>');
    state.consecutiveFailures++;
    saveState();
    console.error('[b2-backup] BACKUP FAILED (' + trigger + ', ' + state.consecutiveFailures + ' in a row): ' + state.lastError);
    await alert('failure');
    return { ok: false, error: state.lastError };
  } finally {
    state.running = false;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Checked every minute. Also raises an alert if no good backup for 26 hours,
// which catches a job that is stuck or silently not running.
let timer = null;
function start() {
  if (!CFG.enabled) { console.log('[b2-backup] Backblaze backup is OFF (B2_BACKUP_ENABLED is not true)'); return; }
  loadState();
  try { validate(); state.configured = true; } catch (e) { console.error('[b2-backup] BACKUP FAILED (startup): ' + e.message); }
  console.log('[b2-backup] Backblaze backup on: nightly at ' + CFG.utcTime + ' UTC to ' + CFG.bucket + '/' + CFG.prefix +
    (CFG.alertTo ? ', alerts to ' + CFG.alertTo : ', NO alert email set'));
  const tick = async () => {
    await runOnce();
    if (state.lastSuccessAt && Date.now() - Date.parse(state.lastSuccessAt) > STALE_AFTER && !state.running) {
      await alert('failure', 'No verified Backblaze backup since ' + state.lastSuccessAt + (state.lastError ? ' (last problem: ' + state.lastError + ')' : ''));
    }
  };
  setTimeout(tick, 30000).unref();
  timer = setInterval(tick, 60000); timer.unref();
}

module.exports = { start, runOnce, state, CFG, missingConfig, periodsAt };
