/**
 * GET /api/diag
 *
 * Diagnostic endpoint. Returns which env vars are configured (boolean only,
 * never the values themselves) and runs a tiny live ping against Gemini to
 * confirm the API key actually works.
 *
 * Visit /api/diag in your browser after deploying to see what's wrong.
 */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const env = {
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    PEXELS_API_KEY: !!process.env.PEXELS_API_KEY,
    PIXABAY_API_KEY: !!process.env.PIXABAY_API_KEY,
    UNSPLASH_ACCESS_KEY: !!process.env.UNSPLASH_ACCESS_KEY,
    AUTH_SECRET: !!process.env.AUTH_SECRET,
    POSTGRES_URL: !!process.env.POSTGRES_URL || !!process.env.DATABASE_URL,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
  };

  const checks = {
    gemini: await pingGemini(),
    pexels: await pingPexels(),
    pixabay: await pingPixabay(),
    unsplash: await pingUnsplash(),
  };

  const allFeatures = {
    'AI generate (text→image)': env.GEMINI_API_KEY && checks.gemini.ok,
    'AI edit (image→image)': env.GEMINI_API_KEY && checks.gemini.ok,
    'Smart Layout': env.GEMINI_API_KEY && checks.gemini.ok,
    'Stock photos': checks.pexels.ok || checks.pixabay.ok || checks.unsplash.ok,
    'Cloud sync (sign in)': env.AUTH_SECRET && env.POSTGRES_URL,
    'Magic-link emails': env.RESEND_API_KEY,
  };

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform },
    env,
    checks,
    features: allFeatures,
    suggestions: buildSuggestions(env, checks),
  });
}

async function pingGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: 'GEMINI_API_KEY not set' };
  try {
    // Hit the lightweight list-models endpoint to verify the key
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key },
    });
    if (r.ok) {
      const data = await r.json();
      const modelNames = (data.models || []).map(m => m.name);
      // Look for the specific models we use
      const hasNanoBananaPro = modelNames.some(n => n.includes('gemini-3-pro-image-preview'));
      const hasLayoutModel = modelNames.some(n => n.includes('gemini-2.5-flash') && !n.includes('image'));
      const note = [];
      if (!hasNanoBananaPro) note.push('gemini-3-pro-image-preview not found in your account — image generation will fail. Your project may need billing enabled to access preview models.');
      if (!hasLayoutModel) note.push('gemini-2.5-flash not visible — Smart Layout may fail.');
      return {
        ok: true,
        status: r.status,
        modelCount: modelNames.length,
        hasNanoBananaPro,
        hasLayoutModel,
        note: note.join(' ') || null,
      };
    }
    const errText = await r.text();
    let msg;
    try { msg = JSON.parse(errText)?.error?.message; } catch (e) { msg = errText.slice(0, 200); }
    return { ok: false, status: r.status, error: msg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingPexels() {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return { ok: false, error: 'PEXELS_API_KEY not set (optional)' };
  try {
    const r = await fetch('https://api.pexels.com/v1/search?query=test&per_page=1', {
      headers: { Authorization: key },
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function pingPixabay() {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return { ok: false, error: 'PIXABAY_API_KEY not set (optional)' };
  try {
    const r = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=test&per_page=3`);
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function pingUnsplash() {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return { ok: false, error: 'UNSPLASH_ACCESS_KEY not set (optional)' };
  try {
    const r = await fetch('https://api.unsplash.com/photos?per_page=1', {
      headers: { Authorization: 'Client-ID ' + key },
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

function buildSuggestions(env, checks) {
  const out = [];
  if (!env.GEMINI_API_KEY) {
    out.push('Set GEMINI_API_KEY to enable AI generate, edit, and Smart Layout. Get a key at https://aistudio.google.com/apikey then add it under Vercel project Settings -> Environment Variables and redeploy.');
  } else if (!checks.gemini.ok) {
    out.push(`Gemini key is set but the API rejected it: ${checks.gemini.error}. The key may be invalid, restricted to specific APIs, or the project may need billing enabled.`);
  } else if (checks.gemini.hasNanoBananaPro === false) {
    out.push('Your Gemini key works but does NOT have access to gemini-3-pro-image-preview (Nano Banana Pro). Image generation will return 404 or 403. Enable billing on your Google AI Studio project at https://aistudio.google.com/billing — preview image models require a paid tier.');
  }
  if (!env.PEXELS_API_KEY && !env.PIXABAY_API_KEY && !env.UNSPLASH_ACCESS_KEY) {
    out.push('No stock photo source is configured. Add PEXELS_API_KEY, PIXABAY_API_KEY, or UNSPLASH_ACCESS_KEY to enable the Stock tab.');
  }
  if (!env.AUTH_SECRET || !env.POSTGRES_URL) {
    out.push('Cloud accounts disabled. Add AUTH_SECRET (openssl rand -hex 32) and a Vercel Postgres integration to enable sign-in and cross-device sync.');
  }
  if (out.length === 0) out.push('All checks passed!');
  return out;
}
