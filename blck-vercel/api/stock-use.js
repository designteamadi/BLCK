/**
 * POST /api/stock/use
 * Body: { downloadPing: "https://api.unsplash.com/photos/.../download" }
 *
 * Unsplash requires that we hit this endpoint when the user actually uses
 * (places into a design) one of their photos. We don't await it — fire and
 * return.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const url = String(body.downloadPing || '');
    if (!url || !url.startsWith('https://')) {
      return res.status(400).json({ ok: false, error: 'downloadPing required' });
    }
    if (!url.includes('api.unsplash.com')) {
      return res.status(400).json({ ok: false, error: 'Only Unsplash download_location is accepted' });
    }
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) {
      // No Unsplash key — silently acknowledge so the client flow doesn't break
      return res.status(200).json({ ok: true, skipped: true });
    }

    // Fire-and-forget — don't block the response
    fetch(url, { headers: { Authorization: 'Client-ID ' + key } })
      .catch(err => console.warn('Unsplash download ping failed:', err.message));

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}
