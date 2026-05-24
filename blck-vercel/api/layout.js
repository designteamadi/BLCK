/**
 * POST /api/layout
 *
 * Adapts a design from a master artboard to a new aspect ratio using Gemini.
 * Now sends an actual RENDERED IMAGE of the master design (not just JSON
 * coordinates) so the model can SEE the composition, hierarchy, color
 * blocking, and visual weight — and produce intentional layouts instead
 * of mechanical reshuffles.
 *
 * Returns new x/y/w/h (and fontSize for text) for each element.
 *
 * Uses gemini-2.5-flash (multimodal — accepts images as input).
 *
 * Body:
 *   {
 *     master: {
 *       width, height: number,
 *       elements: [{ id, type, role, x, y, w, h, text?, fontSize?, ... }],
 *       imageBase64?: string   // PNG/JPEG of master rendered at ~512px wide
 *     },
 *     target: { width, height, name? }
 *   }
 */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          fontSize: { type: 'number' },
        },
        required: ['id', 'x', 'y', 'w', 'h'],
      },
    },
    rationale: { type: 'string' },
  },
  required: ['elements'],
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'GEMINI_API_KEY is not set on this Vercel deployment.',
    });
  }

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const master = body.master;
    const target = body.target;

    if (!master || !target || !Array.isArray(master.elements)) {
      return res.status(400).json({ ok: false, error: 'master and target are required' });
    }
    if (!master.width || !master.height || !target.width || !target.height) {
      return res.status(400).json({ ok: false, error: 'width and height must be positive' });
    }
    if (master.elements.length === 0) {
      return res.status(200).json({ ok: true, elements: [], rationale: 'Empty master.' });
    }
    if (master.elements.length > 60) {
      return res.status(400).json({ ok: false, error: 'Too many elements (max 60).' });
    }

    const slimElements = master.elements.map(el => ({
      id: el.id,
      type: el.type,
      role: el.role || inferRole(el),
      x: round(el.x), y: round(el.y), w: round(el.w), h: round(el.h),
      ...(el.type === 'text' ? { text: clip(el.text || '', 140), fontSize: round(el.fontSize || 24) } : {}),
      ...(el.type === 'shape' ? { shape: el.shape } : {}),
      ...(el.name ? { name: clip(el.name, 40) } : {}),
    }));

    const masterAspect = (master.width / master.height).toFixed(3);
    const targetAspect = (target.width / target.height).toFixed(3);
    const aspectChange = describeAspectChange(master, target);

    const prompt = buildPrompt({ master, target, slimElements, masterAspect, targetAspect, aspectChange });

    // Build multimodal parts: include the rendered master image if provided
    const parts = [];
    if (master.imageBase64) {
      // Strip data: prefix if present
      let b64 = master.imageBase64;
      let mimeType = 'image/png';
      const m = b64.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mimeType = m[1]; b64 = m[2]; }
      // Cap at ~5MB encoded
      if (b64.length > 7_000_000) {
        return res.status(413).json({ ok: false, error: 'master image too large (max ~5MB)' });
      }
      parts.push({ inlineData: { mimeType, data: b64 } });
    }
    parts.push({ text: prompt });

    const payload = {
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 4096,
      },
    };

    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[layout] Gemini error', upstream.status, errText);
      const msg = extractErrorMessage(errText) || `Gemini API ${upstream.status}`;
      return res.status(upstream.status).json({ ok: false, error: msg, upstreamStatus: upstream.status });
    }

    const data = await upstream.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      console.error('[layout] No text response', { finishReason });
      return res.status(502).json({ ok: false, error: 'Model returned no response. finishReason=' + (finishReason || 'unknown') });
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      console.error('[layout] JSON parse fail:', text.slice(0, 400));
      return res.status(502).json({ ok: false, error: 'Model returned invalid JSON' });
    }

    if (!Array.isArray(parsed.elements)) {
      return res.status(502).json({ ok: false, error: 'Invalid layout response shape' });
    }

    const idSet = new Set(master.elements.map(e => e.id));
    const seen = new Set();
    const clean = [];
    for (const el of parsed.elements) {
      if (!el || typeof el.id !== 'string') continue;
      if (!idSet.has(el.id)) continue;
      if (seen.has(el.id)) continue;
      seen.add(el.id);
      const x = clamp(num(el.x, 0), -target.width, target.width * 2);
      const y = clamp(num(el.y, 0), -target.height, target.height * 2);
      const w = clamp(num(el.w, 100), 1, target.width * 2);
      const h = clamp(num(el.h, 100), 1, target.height * 2);
      const out = { id: el.id, x, y, w, h };
      if (typeof el.fontSize === 'number' && el.fontSize > 0) {
        out.fontSize = clamp(el.fontSize, 6, 2000);
      }
      clean.push(out);
    }

    return res.status(200).json({
      ok: true,
      elements: clean,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 600) : undefined,
      sawImage: !!master.imageBase64,
    });
  } catch (err) {
    console.error('[layout] Handler crash:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}

function describeAspectChange(master, target) {
  const mw = master.width, mh = master.height;
  const tw = target.width, th = target.height;
  const mAspect = mw / mh;
  const tAspect = tw / th;
  if (Math.abs(mAspect - tAspect) < 0.05) return 'same aspect ratio (no rearrangement needed)';
  if (tAspect > 2.5) return 'ULTRA-WIDE BANNER — must use horizontal layout (image and text side-by-side, not stacked)';
  if (tAspect < 0.4) return 'ULTRA-TALL — must stack everything vertically with generous vertical breathing room';
  if (tw > th && mw <= mh) return 'going PORTRAIT → LANDSCAPE — split canvas horizontally, put image on one side and text on the other';
  if (tw < th && mw >= mh) return 'going LANDSCAPE → PORTRAIT — stack vertically, image as hero block at top, text below';
  if (tw > 1.5 * th) return 'wide format — arrange elements side-by-side, narrow text columns';
  if (th > 1.5 * tw) return 'tall format — stack vertically with strong vertical rhythm';
  return 'similar proportions';
}

function buildPrompt({ master, target, slimElements, masterAspect, targetAspect, aspectChange }) {
  const sawImage = '';
  return `You are a senior visual designer. You are looking at an image of a design and must redesign it for a new aspect ratio.

MASTER DESIGN (shown in the image attached above):
- Canvas: ${master.width} × ${master.height} (aspect ${masterAspect})
- ${slimElements.length} elements with these properties (id, type, role, current position):
${JSON.stringify(slimElements, null, 2)}

NEW TARGET ARTBOARD:
- Canvas: ${target.width} × ${target.height} (aspect ${targetAspect})
- Format transition: ${aspectChange}
- Name: ${target.name || 'Artboard'}

CRITICAL: Look at the attached image carefully. Notice the composition, the visual hierarchy, which elements dominate, where the eye goes first. Your job is NOT to scale the design — it is to REDESIGN it for the new aspect ratio so it looks intentional.

RULES:

1. STAY IN BOUNDS. Every element's right edge (x + w) must be ≤ ${target.width}. Every element's bottom edge (y + h) must be ≤ ${target.height}. Elements MUST NOT extend past the canvas.

2. BACKGROUNDS FILL THE NEW CANVAS. Any background element (full-canvas shape in the master) must become {x:0, y:0, w:${target.width}, h:${target.height}} in the new canvas.

3. ADAPT FOR THE NEW SHAPE:
   - Wide banner (target wider than 2:1): arrange elements SIDE-BY-SIDE horizontally. Image on left half, text stack on right half. Or image right, text left. NEVER stack vertically in a wide banner.
   - Story/portrait (target taller than 1:1.5): stack vertically. Image as hero block, text below or above.
   - Square: balanced composition with image and text occupying roughly equal areas.

4. RESIZE TEXT FOR THE NEW CANVAS:
   - In wide banners, headlines should be ~20-25% of canvas height tall.
   - In tall stories, headlines should be ~10-15% of canvas height tall.
   - Body/subhead text proportionally smaller (40-60% of headline size).
   - Minimum readable size: 14px in absolute terms.

5. PRESERVE HIERARCHY. The visual hierarchy from the master must remain — the headline must be the biggest text, the CTA must be the most visually prominent action element, etc.

6. SAFE MARGINS. Keep text/CTAs at least 4-6% of canvas size away from edges. Backgrounds can bleed.

7. NEVER OVERLAP TEXT WITH OTHER TEXT. Image-over-image is fine (when one is background), but headlines, subheads, and CTAs must not collide.

8. OUTPUT EVERY ELEMENT by ID with new x, y, w, h (and fontSize for text). Do not skip any element. Do not invent new ids.

9. ALL VALUES MUST BE INTEGERS. No decimal points.

Return ONLY the JSON object matching the schema. No markdown, no commentary.`;
}

function inferRole(el) {
  if (el.role) return el.role;
  const name = (el.name || '').toLowerCase();
  if (name.includes('logo')) return 'logo';
  if (name.includes('headline') || name.includes('title')) return 'headline';
  if (name.includes('subhead') || name.includes('subtitle')) return 'subheadline';
  if (name.includes('cta') || name.includes('button') || name.includes('register')) return 'cta';
  if (name.includes('background') || name.includes('bg')) return 'background';
  if (name.includes('footer') || name.includes('band')) return 'background';
  if (el.type === 'image' && el.w >= 200 && el.h >= 200) return 'picture';
  return undefined;
}

function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v) { return Math.round(Number(v) || 0); }
function clip(s, n) { return String(s || '').slice(0, n); }
function extractErrorMessage(text) {
  try { return JSON.parse(text)?.error?.message; } catch (e) { return null; }
}
