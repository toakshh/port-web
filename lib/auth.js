'use strict';

/**
 * Two independent access layers for the converter service.
 *
 *  1. **Dashboard key** (`DASHBOARD_TOKEN`) - gates the browser UI in `public/`
 *     and the admin-wide routes, so the deployment cannot be used as a free
 *     app-building service by anyone who finds the URL. It deliberately does
 *     *not* gate `POST /api/convert`: server-to-server integrations keep
 *     working untouched.
 *
 *  2. **Per-job token** - a handshake between the server and whoever created a
 *     job. Both sides contribute entropy, the token is returned exactly once,
 *     and only its SHA-256 digest is persisted. Job status, logs, cancellation
 *     and downloads then require proof of possession, so one client can never
 *     poll or download another client's build - even by guessing a job id.
 *
 * Everything here compares secrets in constant time; a plain `===` on a token
 * leaks its prefix through response timing.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const P = require('./paths');

const COOKIE_NAME = 'tripo_dash';
/** How long a browser stays unlocked before it has to enter the key again. */
const SESSION_SECONDS = Number(process.env.DASHBOARD_SESSION_SECONDS) || 12 * 60 * 60;

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

/**
 * Read a secret from disk, generating and persisting one on first use.
 *
 * Persisting matters: a secret regenerated on every boot would sign out every
 * dashboard session on each restart or redeploy.
 */
function persistentSecret(name) {
  const file = path.join(P.WORKSPACE, name);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (_) {
    /* first run */
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(P.WORKSPACE, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (_) {
    // A read-only workspace is survivable - sessions just end at restart.
  }
  return generated;
}

let signingSecret = null;
function getSigningSecret() {
  if (!signingSecret) signingSecret = persistentSecret('session-secret');
  return signingSecret;
}

let dashboardToken = null;
let dashboardTokenGenerated = false;

/**
 * The dashboard key. Configured through `DASHBOARD_TOKEN`; when that is unset
 * one is generated and persisted rather than leaving the UI open, so a
 * deployment is never accidentally unprotected. The generated value is printed
 * once at boot.
 */
function getDashboardToken() {
  if (dashboardToken) return dashboardToken;

  const configured = (process.env.DASHBOARD_TOKEN || '').trim();
  if (configured) {
    dashboardToken = configured;
    return dashboardToken;
  }

  dashboardToken = persistentSecret('dashboard-token');
  dashboardTokenGenerated = true;
  return dashboardToken;
}

/** True when no DASHBOARD_TOKEN was configured and one had to be generated. */
function isDashboardTokenGenerated() {
  getDashboardToken();
  return dashboardTokenGenerated;
}

/* ------------------------------------------------------------------ *
 * Constant-time comparison
 * ------------------------------------------------------------------ */

function safeEqual(a, b) {
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Hashing both sides first makes the compared buffers always 32
  // bytes, so unequal lengths cost exactly as much as unequal contents.
  const ha = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * Dashboard session cookie
 * ------------------------------------------------------------------ */

function signSession(expiresAt) {
  const mac = crypto
    .createHmac('sha256', getSigningSecret())
    .update(`dash:${expiresAt}`)
    .digest('hex');
  return `${expiresAt}.${mac}`;
}

function verifySession(value) {
  if (!value || typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;

  const expiresAt = Number(value.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  return safeEqual(value, signSession(expiresAt));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res) {
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(signSession(expiresAt))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_SECONDS}`
  ];
  // Behind Caddy the app itself speaks plain HTTP, so trust the proxy header
  // rather than req.secure alone or the cookie is never marked Secure.
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Whether this request may act as the operator: a valid dashboard session
 * cookie, or the dashboard key presented directly (which is how curl and
 * scripts reach the admin routes).
 */
function isDashboardRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (verifySession(cookies[COOKIE_NAME])) return true;

  const presented =
    req.headers['x-dashboard-key'] ||
    (req.query && req.query.key) ||
    (req.body && req.body.dashboardKey);

  return Boolean(presented) && safeEqual(presented, getDashboardToken());
}

/* ------------------------------------------------------------------ *
 * Converter token authentication (generation requests)
 * ------------------------------------------------------------------ */

const DEFAULT_CONVERTER_TOKEN = 'DRRJLpHH0aShP63mK0Phej3kpkMBbKTS3do1GSkAZMdIb7BSb4t1htoaLwZHTs5F';

function getConverterToken() {
  const configured = (process.env.CONVERTER_TOKEN || '').trim();
  return configured || DEFAULT_CONVERTER_TOKEN;
}

/**
 * Verify that a generation request carries the required x-converter-token header.
 */
function verifyConverterToken(req) {
  const presented =
    (req.headers && req.headers['x-converter-token']) ||
    (req.query && req.query.converterToken) ||
    (req.body && req.body.converterToken);

  return Boolean(presented) && safeEqual(presented, getConverterToken());
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  DEFAULT_CONVERTER_TOKEN,
  getDashboardToken,
  isDashboardTokenGenerated,
  isDashboardRequest,
  setSessionCookie,
  clearSessionCookie,
  safeEqual,
  sha256,
  getConverterToken,
  verifyConverterToken
};
