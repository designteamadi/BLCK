/**
 * GET /api/auth/me
 * Returns the current signed-in user or 401.
 */
import { getUserFromReq } from '../../lib/auth.js';

export default function handler(req, res) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, signedIn: false });
  return res.status(200).json({
    ok: true,
    signedIn: true,
    user: { id: user.sub, email: user.email },
  });
}
