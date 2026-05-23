// Shared auth utilities — JWT, cookies, Postgres, email
// Used by both /api/auth/* and /api/projects.js

import crypto from 'node:crypto';

// ============ CONFIG ============
export const AUTH_SECRET = process.env.AUTH_SECRET || 'CHANGE_ME_IN_PRODUCTION_USE_32_PLUS_RANDOM_BYTES';
export const SESSION_DAYS = 30;
export const MAGIC_LINK_TTL_MIN = 15;

// ============ JWT (HS256, no deps) ============
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function signJwt(payload, ttlSec = SESSION_DAYS * 86400) {
  const header = b64url(JSON.stringify({alg:'HS256', typ:'JWT'}));
  const now = Math.floor(Date.now()/1000);
  const body = b64url(JSON.stringify({...payload, iat: now, exp: now + ttlSec}));
  const sig = b64url(
    crypto.createHmac('sha256', AUTH_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expectedSig = b64url(
    crypto.createHmac('sha256', AUTH_SECRET).update(`${header}.${body}`).digest()
  );
  // Constant-time compare
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(b64urlDec(body).toString());
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch (e) { return null; }
}

// ============ COOKIES ============
export function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setSessionCookie(res, token) {
  const cookie = [
    `blck_session=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'blck_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
}

export function getUserFromReq(req) {
  const token = getCookie(req, 'blck_session');
  if (!token) return null;
  return verifyJwt(token);
}

// ============ POSTGRES (Vercel Postgres / Neon) ============
// We use the @vercel/postgres SDK if present (loaded via dynamic import to
// avoid breaking when the env var isn't configured yet).
let _sql = null;
export async function getSql() {
  if (_sql) return _sql;
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    throw new Error('POSTGRES_URL or DATABASE_URL not configured');
  }
  const mod = await import('@vercel/postgres');
  _sql = mod.sql;
  return _sql;
}

// Create schema lazily (idempotent)
let _schemaInitDone = false;
export async function ensureSchema() {
  if (_schemaInitDone) return;
  const sql = await getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      folder_id TEXT,
      group_id TEXT,
      data JSONB NOT NULL,
      thumb TEXT,
      modified TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, modified DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      brand_kit JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  _schemaInitDone = true;
}

// ============ EMAIL (Resend) ============
export async function sendMagicLinkEmail(toEmail, link) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'BLCK Studio <onboarding@resend.dev>';
  if (!apiKey) {
    // No mail provider configured — log and return so caller can fall back
    console.warn('RESEND_API_KEY not set. Magic link (dev mode):', link);
    return { ok: true, devMode: true, link };
  }
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0A0A0A;padding:40px;color:#F5F2EC">
      <div style="max-width:480px;margin:0 auto">
        <div style="font-family:'JetBrains Mono',monospace;font-size:14px;letter-spacing:0.05em;color:#F5F2EC;margin-bottom:8px">BLCK<span style="color:#FF5949">.</span></div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.15em;color:#9A968D;text-transform:uppercase;margin-bottom:32px">SIGN-IN LINK / VALID 15 MIN</div>
        <h1 style="font-size:24px;font-weight:500;margin:0 0 16px">Sign in to BLCK. Studio</h1>
        <p style="color:#9A968D;line-height:1.6;margin-bottom:32px">Click the link below to sign in. If you didn't request this, you can ignore this email — the link will expire in 15 minutes.</p>
        <a href="${link}" style="display:inline-block;background:#FF5949;color:#0A0A0A;padding:14px 24px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;text-decoration:none">Sign in →</a>
        <div style="margin-top:40px;padding-top:24px;border-top:1px solid #2D2D2D;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.15em;color:#5F5C56;text-transform:uppercase">
          OR PASTE THIS URL:<br>
          <span style="word-break:break-all;color:#9A968D;text-transform:none">${link}</span>
        </div>
      </div>
    </div>
  `;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: toEmail,
      subject: 'Sign in to BLCK. Studio',
      html,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Resend error: ' + err);
  }
  return { ok: true };
}

// ============ HELPERS ============
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
export function uid() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}
export function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s||'');
}
