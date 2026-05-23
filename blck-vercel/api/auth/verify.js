/**
 * GET /api/auth/verify?token=...
 *
 * Validates the magic-link token, creates or finds the user, sets a JWT cookie,
 * and redirects to /.
 */
import {
  getSql, ensureSchema, signJwt, setSessionCookie, uid,
} from '../../lib/auth.js';

export default async function handler(req, res) {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).send('Missing token');

    const sql = await getSql();
    await ensureSchema();

    // Atomic claim — mark used, return row only if it was unused and unexpired
    const claim = await sql`
      UPDATE magic_links
      SET used = TRUE
      WHERE token = ${token}
        AND used = FALSE
        AND expires_at > NOW()
      RETURNING email
    `;

    if (!claim.rows || claim.rows.length === 0) {
      return res.status(400).send(renderErrorPage(
        'Link expired or already used',
        'Magic links work once and last 15 minutes. Request a new one from the sign-in screen.'
      ));
    }

    const email = claim.rows[0].email;

    // Upsert user
    const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    let userId;
    if (existing.rows.length) {
      userId = existing.rows[0].id;
    } else {
      userId = uid();
      await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
    }

    const jwt = signJwt({ sub: userId, email });
    setSessionCookie(res, jwt);

    res.writeHead(302, { Location: '/?signedin=1' });
    res.end();
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).send(renderErrorPage('Something went wrong', err.message || 'Internal error'));
  }
}

function renderErrorPage(title, body) {
  return `<!doctype html><html><head><title>${title}</title>
  <meta charset="utf-8">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0A0A0A;color:#F5F2EC;margin:0;padding:80px 40px;text-align:center}
    .wrap{max-width:480px;margin:0 auto}
    .tag{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.15em;color:#9A968D;text-transform:uppercase;margin-bottom:12px}
    h1{font-size:24px;font-weight:500;margin:0 0 12px}
    p{color:#9A968D;line-height:1.6;margin-bottom:32px}
    a{display:inline-block;background:#FF5949;color:#0A0A0A;padding:14px 24px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;text-decoration:none}
  </style></head><body><div class="wrap">
    <div class="tag">AUTH / FAILED</div><h1>${title}</h1><p>${body}</p>
    <a href="/">Back to app</a></div></body></html>`;
}
