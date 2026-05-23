/**
 * POST /api/auth/login
 * Body: { email: string }
 *
 * Sends a magic-link email and inserts a single-use token row.
 * Always returns 200 even on unknown emails (anti-enumeration), unless email is malformed.
 */
import {
  getSql, ensureSchema, randomToken, validEmail,
  sendMagicLinkEmail, MAGIC_LINK_TTL_MIN,
} from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }

    let dbAvailable = true;
    try {
      const sql = await getSql();
      await ensureSchema();
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000).toISOString();
      await sql`INSERT INTO magic_links (token, email, expires_at) VALUES (${token}, ${email}, ${expiresAt})`;

      const origin = req.headers['x-forwarded-proto'] && req.headers.host
        ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
        : `https://${req.headers.host || 'localhost'}`;
      const link = `${origin}/api/auth/verify?token=${token}`;

      const mail = await sendMagicLinkEmail(email, link);
      // In dev mode (no RESEND_API_KEY), return the link so the user can click it directly.
      return res.status(200).json({
        ok: true,
        devMode: mail.devMode || false,
        link: mail.devMode ? link : undefined,
      });
    } catch (dbErr) {
      console.error('Login DB error:', dbErr);
      dbAvailable = false;
    }

    if (!dbAvailable) {
      return res.status(503).json({
        ok: false,
        error: 'Cloud sync not configured — set POSTGRES_URL and RESEND_API_KEY in Vercel project settings to enable accounts. Local-only mode still works in your browser.',
      });
    }
  } catch (err) {
    console.error('Login handler:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}
