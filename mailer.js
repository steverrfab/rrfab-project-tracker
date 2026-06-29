'use strict';
// Email sender for the project tracker. Mirrors the bid tool: prefers Microsoft
// Graph (AZURE_* env vars), falls back to SMTP (SMTP_* env vars). Reuse the SAME
// values already set on the bid service so no new credentials are needed.
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* optional */ }

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const FROM_NAME = 'R&R Project Tracker';
const TOKEN_TIMEOUT_MS = 10000, SEND_TIMEOUT_MS = 15000;

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(label + ' timed out')), ms))]);
}
function graphConfigured() {
  return !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET && process.env.AZURE_SENDER_USER);
}
function smtpConfigured() {
  return !!(nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS);
}
function isConfigured() { return graphConfigured() || smtpConfigured(); }

let cachedToken = null, cachedExp = 0;
async function getGraphToken() {
  const now = Date.now();
  if (cachedToken && cachedExp > now + 60000) return cachedToken;
  const tenant = process.env.AZURE_TENANT_ID;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: GRAPH_SCOPE, grant_type: 'client_credentials',
  }).toString();
  const res = await withTimeout(fetch('https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }), TOKEN_TIMEOUT_MS, 'OAuth token');
  if (!res.ok) throw new Error('Token request failed: ' + res.status + ' ' + (await res.text()));
  const data = await res.json();
  cachedToken = data.access_token; cachedExp = now + data.expires_in * 1000;
  return cachedToken;
}
async function sendViaGraph({ to, subject, html, text }) {
  const sender = process.env.AZURE_SENDER_USER;
  const message = {
    subject, body: { contentType: 'HTML', content: html || text || '' },
    from: { emailAddress: { address: sender, name: process.env.AZURE_SENDER_DISPLAY || FROM_NAME } },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  const token = await getGraphToken();
  const res = await withTimeout(fetch(GRAPH_BASE + '/users/' + encodeURIComponent(sender) + '/sendMail', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: 'true' }),
  }), SEND_TIMEOUT_MS, 'Graph sendMail');
  if (res.status === 202) return { ok: true };
  throw new Error('Graph sendMail failed: ' + res.status + ' ' + (await res.text()));
}
async function sendViaSmtp({ to, subject, html, text }) {
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com', port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 12000,
  });
  const from = process.env.SMTP_FROM || '"' + FROM_NAME + '" <' + process.env.SMTP_USER + '>';
  await withTimeout(t.sendMail({ from, to, subject, text, html }), SEND_TIMEOUT_MS, 'SMTP send');
  return { ok: true };
}
async function sendMail(opts) {
  if (graphConfigured()) return sendViaGraph(opts);
  if (smtpConfigured()) return sendViaSmtp(opts);
  throw new Error('Email is not configured');
}
module.exports = { sendMail, isConfigured };
