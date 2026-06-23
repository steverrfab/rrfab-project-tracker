// Authentication: password hashing, JWT cookie sessions, role guards.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE = 'rrtoken';

// Stable signing secret persisted on the Railway volume so sessions survive redeploys.
const SECRET_PATH = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || './data', 'jwt_secret');
function loadSecret() {
  try { const s = fs.readFileSync(SECRET_PATH, 'utf8').trim(); if (s) return s; } catch (_) {}
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true }); fs.writeFileSync(SECRET_PATH, s); } catch (_) {}
  return s;
}
const SECRET = process.env.JWT_SECRET || loadSecret();

const hashPassword = pw => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, hash) => { try { return bcrypt.compareSync(pw, hash); } catch (_) { return false; } };
const signToken = u => jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '30d' });

function parseCookies(req) {
  const out = {}; const h = req.headers && req.headers.cookie; if (!h) return out;
  h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function getUserFromReq(req) {
  const t = parseCookies(req)[COOKIE]; if (!t) return null;
  try { return jwt.verify(t, SECRET); } catch (_) { return null; }
}
function requireAuth(req, res, next) {
  const u = getUserFromReq(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = u; next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for that' });
    next();
  };
}
function setAuthCookie(res, u) {
  res.cookie(COOKIE, signToken(u), { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 30 * 24 * 3600 * 1000 });
}
function clearAuthCookie(res) { res.clearCookie(COOKIE); }

module.exports = { COOKIE, hashPassword, verifyPassword, getUserFromReq, requireAuth, requireRole, setAuthCookie, clearAuthCookie };
