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
          // When true, element is omitted from this artboard (too cramped,
          // low priority). Client hides the element but keeps the data.
          omit: { type: 'boolean' },
          // For images: an optional crop hint in the SOURCE image's 0..1
          // coordinate space. Tells client what part of the original image
          // to show. e.g. {x:0.1, y:0.0, w:0.8, h:1.0} = crop 10% off left
          // and right, keep full height.
          cropX: { type: 'number' },
          cropY: { type: 'number' },
          cropW: { type: 'number' },
          cropH: { type: 'number' },
        },
        required: ['id'],
      },
    },
    rationale: { type: 'string' },
    omitted: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs of elements omitted from this layout due to space constraints',
    },
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

    // Compute IMPORTANCE for each element so the model knows what to KEEP
    // when space is tight and what is OK to omit.
    const importance = (el) => {
      const role = el.role || inferRole(el);
      // Higher = more important. Background must always render (low to keep
      // omit-bias toward foreground decoration, but rank just below
      // foreground content).
      if (role === 'headline' || role === 'title') return 100;
      if (role === 'cta' || role === 'button') return 95;
      if (role === 'logo' || role === 'brand') return 90;
      if (el.type === 'image' && (role === 'picture' || role === 'hero')) return 85;
      if (role === 'subheadline' || role === 'subtitle') return 80;
      if (role === 'body' || el.type === 'text') return 60;
      if (el.type === 'image') return 55;
      if (role === 'background') return 50;
      if (el.type === 'shape') return 30;
      if (el.type === 'line') return 25;
      return 40;
    };

    const slimElements = master.elements.map(el => ({
      id: el.id,
      type: el.type,
      role: el.role || inferRole(el),
      priority: importance(el),
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
        // Higher budget — image input + thinking + JSON for 20 elements can
        // easily exceed 4096 tokens. Truncation here is the most common cause
        // of "invalid JSON" errors.
        maxOutputTokens: 8192,
        // Disable thinking — image input was triggering verbose thinking
        // tokens that ate the output budget before JSON could complete.
        thinkingConfig: { thinkingBudget: 0 },
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

    // Concatenate text from ALL parts. Gemini sometimes returns thinking/
    // commentary as one part and the actual JSON as a later part. Reading
    // only parts[0] was missing the JSON entirely.
    const allParts = data?.candidates?.[0]?.content?.parts || [];
    const text = allParts.map(p => p.text || '').join('').trim();
    const finishReason = data?.candidates?.[0]?.finishReason;

    if (!text) {
      console.error('[layout] No text in response', { finishReason, partCount: allParts.length });
      return res.status(502).json({
        ok: false,
        error: 'Model returned no response. finishReason=' + (finishReason || 'unknown'),
      });
    }

    // If finishReason indicates truncation, the JSON is likely incomplete
    if (finishReason === 'MAX_TOKENS') {
      console.error('[layout] Response truncated by MAX_TOKENS');
      return res.status(502).json({
        ok: false,
        error: 'Response truncated. Master design too complex — try fewer elements or simpler text.',
        finishReason,
      });
    }

    // Robust JSON extraction: handle markdown fences, leading prose,
    // trailing commentary by finding the first { and matching closing }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e1) {
      // Try stripping markdown fences
      let stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      try {
        parsed = JSON.parse(stripped);
      } catch (e2) {
        // Last resort: find first {...} object by brace counting
        const extracted = extractJsonObject(text);
        if (extracted) {
          try { parsed = JSON.parse(extracted); }
          catch (e3) { /* give up */ }
        }
      }
    }

    if (!parsed) {
      console.error('[layout] JSON parse fail. Text was:', text.slice(0, 800));
      return res.status(502).json({
        ok: false,
        error: 'Model returned invalid JSON',
        // Return a snippet of what the model actually said — helps debug
        // without exposing too much in production
        modelTextSnippet: text.slice(0, 200),
        finishReason,
      });
    }

    if (!Array.isArray(parsed.elements)) {
      return res.status(502).json({ ok: false, error: 'Invalid layout response shape' });
    }

    const idSet = new Set(master.elements.map(e => e.id));
    const seen = new Set();
    const clean = [];
    const omittedIds = [];
    for (const el of parsed.elements) {
      if (!el || typeof el.id !== 'string') continue;
      if (!idSet.has(el.id)) continue;
      if (seen.has(el.id)) continue;
      seen.add(el.id);

      // Omit path: element is dropped from this artboard's render
      if (el.omit === true) {
        clean.push({ id: el.id, omit: true });
        omittedIds.push(el.id);
        continue;
      }

      const x = clamp(num(el.x, 0), -target.width, target.width * 2);
      const y = clamp(num(el.y, 0), -target.height, target.height * 2);
      const w = clamp(num(el.w, 100), 1, target.width * 2);
      const h = clamp(num(el.h, 100), 1, target.height * 2);
      const out = { id: el.id, x, y, w, h };
      if (typeof el.fontSize === 'number' && el.fontSize > 0) {
        out.fontSize = clamp(el.fontSize, 6, 2000);
      }
      // Crop hints: pass through if they're sensible 0..1 fractions
      const validCrop =
        typeof el.cropX === 'number' && typeof el.cropY === 'number' &&
        typeof el.cropW === 'number' && typeof el.cropH === 'number' &&
        el.cropX >= 0 && el.cropY >= 0 && el.cropW > 0 && el.cropH > 0 &&
        el.cropX + el.cropW <= 1.001 && el.cropY + el.cropH <= 1.001;
      if (validCrop) {
        out.cropX = Math.max(0, el.cropX);
        out.cropY = Math.max(0, el.cropY);
        out.cropW = Math.min(1 - out.cropX, el.cropW);
        out.cropH = Math.min(1 - out.cropY, el.cropH);
      }
      clean.push(out);
    }

    return res.status(200).json({
      ok: true,
      elements: clean,
      omitted: omittedIds,
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
  // Pixel area ratio — when target is much smaller than master, we should
  // hint at omission.
  const masterArea = master.width * master.height;
  const targetArea = target.width * target.height;
  const areaRatio = targetArea / masterArea;
  const isCramped = areaRatio < 0.45 || target.width < 400 || target.height < 400;

  return `You are a senior visual designer. You are looking at an image of a design and must redesign it for a new aspect ratio.

MASTER DESIGN (shown in the image attached above):
- Canvas: ${master.width} × ${master.height} (aspect ${masterAspect})
- ${slimElements.length} elements with these properties (id, type, role, priority, current position):
${JSON.stringify(slimElements, null, 2)}

PRIORITY GUIDE — when space is tight, KEEP high-priority items and OMIT low ones:
  100 = headline (always keep)
   95 = CTA / call-to-action button (always keep)
   90 = logo / brand mark (almost always keep)
   85 = hero image / picture (keep if there's room for it to be meaningful, ≥30% of canvas)
   80 = subheadline / supporting headline
   60 = body text
   55 = secondary images
   50 = background fill
   30 = decorative shapes
   25 = decorative lines

NEW TARGET ARTBOARD:
- Canvas: ${target.width} × ${target.height} (aspect ${targetAspect})
- Format transition: ${aspectChange}
- Pixel area vs master: ${(areaRatio * 100).toFixed(0)}%
- Cramped? ${isCramped ? 'YES — be aggressive about omitting low-priority decoration' : 'No — fit everything if possible'}
- Name: ${target.name || 'Artboard'}

CRITICAL: Look at the attached image carefully. Notice the composition, the visual hierarchy, which elements dominate, where the eye goes first. Your job is NOT to scale the design — it is to REDESIGN it for the new aspect ratio so it looks intentional.

RULES:

1. STAY IN BOUNDS. Every element's right edge (x + w) must be ≤ ${target.width}. Every element's bottom edge (y + h) must be ≤ ${target.height}. Elements MUST NOT extend past the canvas.

2. READABILITY OVER COMPLETENESS. If the target canvas is too small to fit everything legibly, OMIT low-priority decorations (priority ≤ 50). Mark omitted elements with "omit": true in the response. The message must remain READABLE. A clean, legible layout with 5 elements beats a cramped illegible one with 10.

3. BACKGROUNDS FILL THE NEW CANVAS. Any background element (full-canvas shape in the master) must become {x:0, y:0, w:${target.width}, h:${target.height}} in the new canvas. (Unless omitted entirely.)

4. ADAPT FOR THE NEW SHAPE:
   - Wide banner (target wider than 2:1): arrange elements SIDE-BY-SIDE horizontally. Image on left half, text stack on right half. Or image right, text left. NEVER stack vertically in a wide banner.
   - Story/portrait (target taller than 1:1.5): stack vertically. Image as hero block, text below or above.
   - Square: balanced composition with image and text occupying roughly equal areas.

5. RESIZE TEXT FOR THE NEW CANVAS:
   - In wide banners, headlines should be ~20-25% of canvas height tall.
   - In tall stories, headlines should be ~10-15% of canvas height tall.
   - Body/subhead text proportionally smaller (40-60% of headline size).
   - Minimum readable size: 14px in absolute terms. If headline can't fit at 14px+, shorten the layout or omit some elements.

6. IMAGE CROPPING. For image elements, you may suggest a CROP rectangle within the image's source pixels using cropX, cropY, cropW, cropH (each is 0..1 fractional). For example {cropX:0, cropY:0.2, cropW:1, cropH:0.6} crops the middle 60% horizontally. Use this when changing aspect ratio significantly — e.g. landscape image into a tall canvas should crop to vertical center band. Default (no crop fields) = use full image.

7. PRESERVE HIERARCHY. The visual hierarchy from the master must remain — the headline must be the biggest text, the CTA must be the most visually prominent action element, etc.

8. SAFE MARGINS. Keep text/CTAs at least 4-6% of canvas size away from edges. Backgrounds can bleed.

9. NEVER OVERLAP TEXT WITH OTHER TEXT. Image-over-image is fine (when one is background), but headlines, subheads, and CTAs must not collide.

10. OUTPUT EVERY ELEMENT by ID. Either:
    - Layout it: provide x, y, w, h (and fontSize for text, cropX/Y/W/H for images)
    - OR omit it: provide just {"id": "...", "omit": true}
    Every master element must appear in the response.

11. ALL DIMENSIONS MUST BE INTEGERS. Crop hints (cropX/Y/W/H) are decimals 0..1.

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

// Extract the first complete JSON object from text by brace counting.
// Handles cases where Gemini wraps JSON in prose ("Here's the layout: {...}").
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractErrorMessage(text) {
  try { return JSON.parse(text)?.error?.message; } catch (e) { return null; }
}
