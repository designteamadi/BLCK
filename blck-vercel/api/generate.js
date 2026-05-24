/**
 * POST /api/generate
 *
 * Body:
 *   {
 *     prompt: string,
 *     aspectRatio?: "1:1"|"2:3"|"3:2"|"3:4"|"4:3"|"4:5"|"5:4"|"9:16"|"16:9"|"21:9"|"1:4"|"4:1"|"1:8"|"8:1",
 *     imageSize?: "512"|"1K"|"2K"|"4K",
 *     thinkingLevel?: "minimal"|"low"|"medium"|"high",
 *     transparent?: boolean
 *   }
 *
 * Response:
 *   { ok: true, image: "data:image/png;base64,...", mime: "image/png" }
 *   { ok: false, error: "..." }
 *
 * Uses Nano Banana Pro (Gemini 3 Pro Image Preview).
 * Per https://ai.google.dev/gemini-api/docs/image-generation the REST format is:
 *   generationConfig: {
 *     imageConfig: { aspectRatio, imageSize },
 *     thinkingConfig: { thinkingLevel }
 *   }
 *
 * Note: do NOT pass responseModalities for Gemini 3 image models — the model
 * returns both text (commentary) and image parts automatically.
 */

const MODEL = 'gemini-3-pro-image-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ALLOWED_RATIOS = [
  '1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9',
  '1:4','4:1','1:8','8:1',
];

const ALLOWED_SIZES = ['512', '1K', '2K', '4K'];
const DEFAULT_SIZE = '1K';

const ALLOWED_THINKING = ['low', 'medium', 'high'];
const DEFAULT_THINKING = 'low';

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
    // Client may send "minimal" — map to "low" for compatibility
    let rawThinking = body.thinkingLevel;
    if (rawThinking === 'minimal') rawThinking = 'low';
    const thinkingLevel = ALLOWED_THINKING.includes(rawThinking) ? rawThinking : DEFAULT_THINKING;
    const transparent = Boolean(body.transparent);

    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
    if (prompt.length > 4000) return res.status(400).json({ ok: false, error: 'prompt too long (max 4000 chars)' });

    let finalPrompt = prompt;
    if (transparent) {
      finalPrompt =
        `${prompt}\n\nCRITICAL: Render the subject on a fully transparent background. ` +
        `No backdrop, no scene, no surface, no ground shadow. Clean cutout edges, ` +
        `ready to composite as a PNG sticker.`;
    }

    const payload = {
      contents: [{ parts: [{ text: finalPrompt }] }],
      generationConfig: {
        imageConfig: { aspectRatio, imageSize },
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
        error: 'Model returned no image. Possible causes: prompt was filtered, or your API key does not have access to gemini-3-pro-image-preview (image generation requires a Google AI Studio project with billing enabled).',
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
  // Gemini 3 returns both text (commentary) and image parts. Find any inline image.
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
    return 'Your API key does not have permission for this model. Nano Banana Pro requires billing enabled on the Google AI Studio project.';
  }
  if (status === 404 && /not found|model/i.test(msg)) {
    return 'The model gemini-3-pro-image-preview may not be available in your region or your project may need access to preview models.';
  }
  if (status === 429) return 'Rate limited. Wait a moment and try again.';
  return null;
}
