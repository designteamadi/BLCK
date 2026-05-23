/**
 * POST /api/layout
 *
 * Adapts a design from a master artboard to a new aspect ratio using Gemini.
 * Returns new x/y/w/h (and fontSize for text) for each element so the layout
 * looks intentional in the new ratio rather than just proportionally squished.
 *
 * Body:
 *   {
 *     master: {
 *       width:  number,
 *       height: number,
 *       elements: [
 *         {
 *           id: string,
 *           type: 'text' | 'image' | 'shape' | 'path',
 *           role?: 'logo' | 'headline' | 'subheadline' | 'cta' | 'picture' | 'background',
 *           x, y, w, h: number,
 *           text?: string,          // for text elements
 *           fontSize?: number,
 *           shape?: string,         // for shape elements: 'rect', 'circle', etc.
 *           name?: string,
 *         }
 *       ]
 *     },
 *     target: { width: number, height: number, name?: string }
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     elements: [
 *       { id, x, y, w, h, fontSize?, notes? }
 *     ],
 *     rationale?: string
 *   }
 */

const MODEL = 'gemini-2.0-flash';
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
    return res.status(500).json({ ok: false, error: 'Server missing GEMINI_API_KEY' });
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
      // No elements to lay out — just echo back
      return res.status(200).json({ ok: true, elements: [], rationale: 'Empty master — nothing to adapt.' });
    }
    if (master.elements.length > 60) {
      return res.status(400).json({ ok: false, error: 'Too many elements (max 60). Group small assets before resizing.' });
    }

    // Slim the input — Gemini only needs the structural fields, not full base64 images
    const slimElements = master.elements.map(el => ({
      id: el.id,
      type: el.type,
      role: el.role || inferRole(el),
      x: round(el.x), y: round(el.y), w: round(el.w), h: round(el.h),
      ...(el.type === 'text'
        ? {
            text: clip(el.text || '', 140),
            fontSize: round(el.fontSize || 24),
          }
        : {}),
      ...(el.type === 'shape' ? { shape: el.shape } : {}),
      ...(el.name ? { name: clip(el.name, 40) } : {}),
    }));

    const masterAspect = (master.width / master.height).toFixed(3);
    const targetAspect = (target.width / target.height).toFixed(3);
    const aspectChange =
      target.width > target.height && master.width <= master.height ? 'landscape (was square/portrait)'
      : target.width < target.height && master.width >= master.height ? 'portrait (was square/landscape)'
      : target.width === target.height ? 'square'
      : 'similar';

    const prompt = buildPrompt({
      master, target, slimElements, masterAspect, targetAspect, aspectChange,
    });

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
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
      console.error('Gemini layout error:', upstream.status, errText);
      return res.status(upstream.status).json({
        ok: false,
        error: extractErrorMessage(errText) || `Gemini API error (${upstream.status})`,
      });
    }

    const data = await upstream.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ ok: false, error: 'No response from model' });
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return res.status(502).json({ ok: false, error: 'Model returned invalid JSON' }); }

    if (!Array.isArray(parsed.elements)) {
      return res.status(502).json({ ok: false, error: 'Invalid layout response' });
    }

    // Validate + clamp results to the target bounds.
    const idSet = new Set(master.elements.map(e => e.id));
    const seen = new Set();
    const clean = [];
    for (const el of parsed.elements) {
      if (!el || typeof el.id !== 'string') continue;
      if (!idSet.has(el.id)) continue;     // unknown id
      if (seen.has(el.id)) continue;        // dupe
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
    });
  } catch (err) {
    console.error('Layout handler error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}

function buildPrompt({ master, target, slimElements, masterAspect, targetAspect, aspectChange }) {
  return `You are a senior visual designer adapting a design from one aspect ratio to another. The goal is a layout that feels intentional in the NEW format, not just a proportional squish.

MASTER ARTBOARD (the design as it exists today):
- Canvas: ${master.width} × ${master.height} (aspect ${masterAspect})
- Elements (top-left origin, pixels):
${JSON.stringify(slimElements, null, 2)}

NEW ARTBOARD (lay out for this):
- Canvas: ${target.width} × ${target.height} (aspect ${targetAspect})
- Format change: ${aspectChange}
- Name: ${target.name || 'Artboard'}

YOUR JOB:
Return new x, y, w, h for EVERY element (using the same ids). For text elements, also return a sensible fontSize. The new layout must:

1. **Preserve hierarchy.** Logo small and in a corner. Headline large and prominent. Subheadline below headline. CTA visible and tappable. Picture/background fills or anchors the composition.
2. **Use the new canvas well.** Do not waste space. Do not leave huge empty regions unless the original was deliberately spacious.
3. **Respect safe margins.** Keep at least 4–6% of canvas size as padding from the edges for primary content (logos, text, CTAs). Backgrounds may bleed edge-to-edge.
4. **Backgrounds first.** Any element with role 'background' or that covered the full master canvas should be resized to fill the new canvas (x:0, y:0, w:target.width, h:target.height).
5. **Adapt for orientation.** Going wide → portrait: stack elements vertically, increase text size if there's room, keep photos as hero blocks. Portrait → wide: arrange elements side-by-side, keep text columns narrow.
6. **Keep text readable.** Min font-size 12px. Don't shrink headlines below 60% of the master's headline font size unless absolutely necessary.
7. **Don't overlap interactive content.** CTAs and headlines must not overlap each other.
8. **Stay in bounds.** All x in [0, target.width - w] and y in [0, target.height - h] for primary content. (Backgrounds may go edge-to-edge.)
9. **Output every element by id.** Don't skip any. Don't invent new ids.

Return the JSON object directly — no markdown fences, no commentary outside the schema.`;
}

function inferRole(el) {
  if (el.role) return el.role;
  const name = (el.name || '').toLowerCase();
  if (name.includes('logo')) return 'logo';
  if (name.includes('headline') || name.includes('title')) return 'headline';
  if (name.includes('subhead') || name.includes('subtitle')) return 'subheadline';
  if (name.includes('cta') || name.includes('button')) return 'cta';
  if (name.includes('background') || name.includes('bg')) return 'background';
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
