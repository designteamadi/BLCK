/**
 * GET /api/stock?q=...&page=1&per_page=20&orientation=&source=pexels|pixabay|unsplash|all
 *
 * Unified stock photo search. Aggregates Pexels (default), Pixabay, and Unsplash
 * into one normalized response. API keys live server-side via env vars:
 *   PEXELS_API_KEY     -- https://www.pexels.com/api/  (free, instant)
 *   PIXABAY_API_KEY    -- https://pixabay.com/api/docs/ (free, instant)
 *   UNSPLASH_ACCESS_KEY -- https://unsplash.com/developers (free demo, 50/hr)
 *
 * If a key is missing, that source is skipped silently. If ALL keys are missing,
 * a clear error message is returned so the user knows to configure at least one.
 *
 * Response (normalized):
 *   {
 *     ok: true,
 *     query: "...",
 *     total: number,                  // best-effort sum across sources
 *     photos: [{
 *       id: "pexels-12345" | ...,
 *       source: "pexels"|"pixabay"|"unsplash",
 *       width, height: number,
 *       url: string,                  // full-size image (hotlinked, never cached by us)
 *       thumb: string,                // small thumbnail for the picker grid
 *       preview: string,              // medium preview for the inspector
 *       avgColor: string | null,      // hex like "#aabbcc" for placeholder
 *       alt: string,
 *       photographer: { name, url },
 *       sourceUrl: string,            // link back to the photo's source page (required for attribution)
 *       downloadPing: string | null,  // call this URL when user actually uses the image (Unsplash requires it)
 *     }],
 *     attribution: { ... }            // per-source attribution text the client must display
 *   }
 */

const ALLOWED_ORIENTATION = new Set(['portrait', 'landscape', 'square']);
const MAX_PER_PAGE = 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Pexels' TOS asks for 24h cache. Vercel's edge cache plus our short s-maxage
  // gives the same effect for repeated queries.
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ ok: false, error: 'q is required' });

    const page = Math.max(1, Math.min(20, parseInt(req.query.page) || 1));
    const perPage = Math.max(1, Math.min(MAX_PER_PAGE, parseInt(req.query.per_page) || 20));
    const orientation = ALLOWED_ORIENTATION.has(req.query.orientation) ? req.query.orientation : null;
    const requested = String(req.query.source || 'all').toLowerCase();

    // Decide which sources to query
    const sources = [];
    if ((requested === 'all' || requested === 'pexels') && process.env.PEXELS_API_KEY) sources.push('pexels');
    if ((requested === 'all' || requested === 'pixabay') && process.env.PIXABAY_API_KEY) sources.push('pixabay');
    if ((requested === 'all' || requested === 'unsplash') && process.env.UNSPLASH_ACCESS_KEY) sources.push('unsplash');

    if (sources.length === 0) {
      return res.status(503).json({
        ok: false,
        error: 'No stock photo source configured. Add at least one of PEXELS_API_KEY, PIXABAY_API_KEY, or UNSPLASH_ACCESS_KEY to your Vercel project environment.',
      });
    }

    // Fan out concurrently; never let one slow source block the others
    const calls = sources.map(s => withTimeout(querySource(s, q, page, perPage, orientation), 8000)
      .catch(err => ({ error: String(err.message || err), source: s, photos: [] })));
    const results = await Promise.all(calls);

    // Interleave photos so the user sees variety from each source at the top
    const photos = interleave(results.map(r => r.photos || []));
    const total = results.reduce((acc, r) => acc + (r.total || 0), 0);

    return res.status(200).json({
      ok: true,
      query: q,
      total,
      photos: photos.slice(0, perPage),
      attribution: {
        pexels: 'Photos provided by Pexels — https://www.pexels.com',
        pixabay: 'Photos provided by Pixabay — https://pixabay.com',
        unsplash: 'Photos provided by Unsplash — https://unsplash.com',
      },
      // Useful for debugging when one source has trouble
      sources: results.map(r => ({
        source: r.source,
        ok: !r.error,
        error: r.error || null,
        count: (r.photos || []).length,
      })),
    });
  } catch (err) {
    console.error('Stock handler error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}

// ============ POST /api/stock — proxy a single image download ============
// Some sources (Unsplash) require us to hit a download endpoint when the user
// commits to using the image. The client calls POST /api/stock?action=download
// with the photo's downloadPing URL.
export async function downloadPing(downloadUrl) {
  if (!downloadUrl) return;
  try {
    const headers = {};
    if (downloadUrl.includes('api.unsplash.com')) {
      const k = process.env.UNSPLASH_ACCESS_KEY;
      if (!k) return;
      headers.Authorization = 'Client-ID ' + k;
    }
    await fetch(downloadUrl, { headers });
  } catch (e) { /* best-effort */ }
}

// ============ SOURCE ADAPTERS ============

async function querySource(source, q, page, perPage, orientation) {
  switch (source) {
    case 'pexels':   return queryPexels(q, page, perPage, orientation);
    case 'pixabay':  return queryPixabay(q, page, perPage, orientation);
    case 'unsplash': return queryUnsplash(q, page, perPage, orientation);
    default: return { source, photos: [], total: 0 };
  }
}

async function queryPexels(q, page, perPage, orientation) {
  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(Math.min(perPage, 80)));
  if (orientation) url.searchParams.set('orientation', orientation);
  const resp = await fetch(url, {
    headers: { Authorization: process.env.PEXELS_API_KEY },
  });
  if (!resp.ok) throw new Error('Pexels ' + resp.status);
  const data = await resp.json();
  return {
    source: 'pexels',
    total: data.total_results || 0,
    photos: (data.photos || []).map(p => ({
      id: 'pexels-' + p.id,
      source: 'pexels',
      width: p.width,
      height: p.height,
      url: p.src.original,
      thumb: p.src.tiny,
      preview: p.src.large || p.src.medium,
      avgColor: p.avg_color || null,
      alt: p.alt || '',
      photographer: { name: p.photographer || '', url: p.photographer_url || '' },
      sourceUrl: p.url,
      downloadPing: null,
    })),
  };
}

async function queryPixabay(q, page, perPage, orientation) {
  const url = new URL('https://pixabay.com/api/');
  url.searchParams.set('key', process.env.PIXABAY_API_KEY);
  url.searchParams.set('q', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(Math.max(3, Math.min(perPage, 200))));   // Pixabay rejects <3
  url.searchParams.set('image_type', 'photo');
  url.searchParams.set('safesearch', 'true');
  if (orientation === 'portrait' || orientation === 'landscape') {
    url.searchParams.set('orientation', orientation === 'landscape' ? 'horizontal' : 'vertical');
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Pixabay ' + resp.status);
  const data = await resp.json();
  return {
    source: 'pixabay',
    total: data.totalHits || 0,
    photos: (data.hits || []).map(p => ({
      id: 'pixabay-' + p.id,
      source: 'pixabay',
      width: p.imageWidth,
      height: p.imageHeight,
      url: p.largeImageURL || p.webformatURL,
      thumb: p.previewURL,
      preview: p.webformatURL,
      avgColor: null,
      alt: p.tags || '',
      photographer: { name: p.user || '', url: 'https://pixabay.com/users/' + (p.user_id || '') + '/' },
      sourceUrl: p.pageURL,
      downloadPing: null,
    })),
  };
}

async function queryUnsplash(q, page, perPage, orientation) {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(Math.min(perPage, 30)));
  if (orientation) {
    // Unsplash uses portrait/landscape/squarish
    url.searchParams.set('orientation', orientation === 'square' ? 'squarish' : orientation);
  }
  const resp = await fetch(url, {
    headers: { Authorization: 'Client-ID ' + process.env.UNSPLASH_ACCESS_KEY },
  });
  if (!resp.ok) throw new Error('Unsplash ' + resp.status);
  const data = await resp.json();
  return {
    source: 'unsplash',
    total: data.total || 0,
    photos: (data.results || []).map(p => ({
      id: 'unsplash-' + p.id,
      source: 'unsplash',
      width: p.width,
      height: p.height,
      url: p.urls.full,
      thumb: p.urls.thumb,
      preview: p.urls.regular,
      avgColor: p.color || null,
      alt: p.alt_description || p.description || '',
      photographer: { name: p.user?.name || '', url: (p.user?.links?.html || '') + '?utm_source=blck_studio&utm_medium=referral' },
      sourceUrl: p.links.html + '?utm_source=blck_studio&utm_medium=referral',
      downloadPing: p.links.download_location || null,
    })),
  };
}

// ============ HELPERS ============

function interleave(lists) {
  const out = [];
  const max = Math.max(...lists.map(l => l.length), 0);
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      if (list[i]) out.push(list[i]);
    }
  }
  return out;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after ' + ms + 'ms')), ms)),
  ]);
}
