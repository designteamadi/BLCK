/**
 * POST /api/generate
 *
 * Body:
 *   {
 *     prompt: string,
 *     aspectRatio?: "1:1"|"2:3"|"3:2"|"3:4"|"4:3"|"4:5"|"5:4"|"9:16"|"16:9"|"21:9"|"1:4"|"4:1"|"1:8"|"8:1",
 *     imageSize?: "512"|"1K"|"2K"|"4K",
 *     thinkingLevel?: "minimal"|"high",
 *     transparent?: boolean
 *   }
 *
 * Response:
 *   { ok: true, image: "data:image/png;base64,...", mime: "image/png" }
 *   { ok: false, error: "..." }
 *
 * Uses Nano Banana 2 (Gemini 3.1 Flash Image Preview) — model ID
 * `gemini-3.1-flash-image-preview`. Per the Feb 2026 docs, the REST format is:
 *   generationConfig: {
 *     responseModalities: ["IMAGE"],
 *     responseFormat: { image: { aspectRatio, imageSize } },
 *     thinkingConfig: { thinkingLevel }
 *   }
 * Note: the older `imageConfig` field is the Gemini 2.5 path and does not
 * apply to Gemini 3.x models.
 */

const MODEL = 'gemini-3.1-flash-image-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Nano Banana 2 supports more aspect ratios than 2.5 did, including ultra-wide
// and ultra-tall formats useful for banners and stories.
const ALLOWED_RATIOS = [
  '1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9',
  '1:4','4:1','1:8','8:1',
];

// Resolution options. Default 1K for speed/cost balance.
// Cost scales: 1K/2K ~ $0.067/img, 4K ~ $0.12/img (vs $0.039 on Nano Banana 1).
const ALLOWED_SIZES = ['512', '1K', '2K', '4K'];
const DEFAULT_SIZE = '1K';

// Thinking level controls the model's internal reasoning depth.
// "minimal" is the default and fastest. "high" produces better results on
// complex prompts but takes longer.
const ALLOWED_THINKING = ['minimal', 'high'];
const DEFAULT_THINKING = 'minimal';

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
      error: 'GEMINI_API_KEY is not set on this Vercel deployment. Add it under Settings → Environment Variables and redeploy.',
    });
  }

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const prompt = String(body.prompt || '').trim();
    const aspectRatio = ALLOWED_RATIOS.includes(body.aspectRatio) ? body.aspectRatio : '1:1';
    const imageSize = ALLOWED_SIZES.includes(body.imageSize) ? body.imageSize : DEFAULT_SIZE;
    const thinkingLevel = ALLOWED_THINKING.includes(body.thinkingLevel) ? body.thinkingLevel : DEFAULT_THINKING;
    const transparent = Boolean(body.transparent);

    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
    if (prompt.length > 4000) return res.status(400).json({ ok: false, error: 'prompt too long (max 4000 chars)' });

    let finalPrompt = prompt;
    if (transparent) {
      // Per Google's docs, Nano Banana doesn't natively output transparent
      // backgrounds — we coax it via explicit prompting. The model is good
      // enough that this works reliably for sticker/asset use.
      finalPrompt =
        `${prompt}\n\nCRITICAL: Render the subject on a fully transparent background. ` +
        `No backdrop, no scene, no surface, no ground shadow. Clean cutout edges, ` +
        `ready to composite as a PNG sticker.`;
    }

    const payload = {
      contents: [{ parts: [{ text: finalPrompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        responseFormat: {
          image: { aspectRatio, imageSize },
        },
        thinkingConfig: { thinkingLevel },
      },
    };

    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[generate] Gemini error', upstream.status, errText);
      const msg = extractErrorMessage(errText) || `Gemini API ${upstream.status}`;
      return res.status(upstream.status).json({
        ok: false,
        error: msg,
        upstreamStatus: upstream.status,
        hint: hintForGeminiError(upstream.status, msg),
      });
    }

    const data = await upstream.json();
    const part = findImagePart(data);

    if (!part) {
      const blocked = data?.promptFeedback?.blockReason;
      if (blocked) {
        return res.status(400).json({
          ok: false,
          error: `Blocked: ${blocked}. Try a different prompt.`,
          blockReason: blocked,
        });
      }
      const finishReason = data?.candidates?.[0]?.finishReason;
      console.error('[generate] No image in response', { finishReason, hasContent: !!data?.candidates?.[0]?.content });
      return res.status(502).json({
        ok: false,
        error: 'Model returned no image. This usually means the prompt was filtered, or your API key does not have access to gemini-3.1-flash-image-preview (image generation requires a project with billing enabled).',
        finishReason,
      });
    }

    const mime = part.inlineData.mimeType || 'image/png';
    const dataUrl = `data:${mime};base64,${part.inlineData.data}`;
    return res.status(200).json({
      ok: true,
      image: dataUrl,
      mime,
      model: MODEL,
      aspectRatio,
      imageSize,
    });
  } catch (err) {
    console.error('[generate] Handler crash:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}

function findImagePart(data) {
  // Nano Banana 2 may return "thought images" before the final one when
  // thinkingLevel=high. Per the docs, the LAST inlineData part is the final
  // rendered image. We also skip parts marked as `thought: true`.
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let finalPart = null;
  for (const p of parts) {
    if (p.thought === true) continue;
    const inline = p.inlineData?.data ? p.inlineData : p.inline_data?.data ? p.inline_data : null;
    if (inline) finalPart = { inlineData: inline };
  }
  return finalPart;
}

function extractErrorMessage(text) {
  try { return JSON.parse(text)?.error?.message; } catch (e) { return null; }
}

function hintForGeminiError(status, msg) {
  if (status === 400 && /API key/i.test(msg)) {
    return 'Check that GEMINI_API_KEY is a valid Google AI Studio key.';
  }
  if (status === 403) {
    return 'Your API key does not have permission for this model. Nano Banana 2 may require billing enabled on the Google AI Studio project.';
  }
  if (status === 404 && /not found|model/i.test(msg)) {
    return 'The model gemini-3.1-flash-image-preview may not be available in your region or your project may need access to preview models. Check https://ai.google.dev/gemini-api/docs/models for the latest list.';
  }
  if (status === 429) return 'Rate limited. Wait a moment and try again.';
  return null;
}
