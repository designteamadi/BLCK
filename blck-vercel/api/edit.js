/**
 * POST /api/edit
 *
 * Body:
 *   {
 *     prompt: string,
 *     image: "data:image/...;base64,..." | { mime: string, data: string },
 *     mode?: "edit" | "remove-bg" | "upscale" | "stylize",
 *     imageSize?: "512"|"1K"|"2K"|"4K",
 *     thinkingLevel?: "minimal"|"high"
 *   }
 *
 * Response:
 *   { ok: true, image: "data:image/png;base64,...", mime: "image/png" }
 *   { ok: false, error: "..." }
 *
 * Uses Nano Banana 2 (Gemini 3.1 Flash Image Preview). For editing, we don't
 * pass an aspectRatio — the docs say the model defaults to matching the input
 * image's dimensions, which is what we want for "edit" mode. For upscale, we
 * explicitly bump imageSize.
 */

const MODEL = 'gemini-3.1-flash-image-preview';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const ALLOWED_SIZES = ['512', '1K', '2K', '4K'];
const ALLOWED_THINKING = ['minimal', 'high'];

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
    let { prompt = '', image, mode = 'edit' } = body;
    prompt = String(prompt).trim();

    if (!image) return res.status(400).json({ ok: false, error: 'image is required' });

    const img = parseImageInput(image);
    if (!img) return res.status(400).json({ ok: false, error: 'invalid image format' });

    const approxBytes = (img.data.length * 3) / 4;
    if (approxBytes > MAX_IMAGE_BYTES) {
      return res.status(413).json({ ok: false, error: 'image too large (max ~15 MB decoded)' });
    }

    let finalPrompt = prompt;
    let imageSize = ALLOWED_SIZES.includes(body.imageSize) ? body.imageSize : null;

    if (mode === 'remove-bg') {
      finalPrompt =
        'Remove the background from this image completely. Keep the main subject perfectly intact with clean, anti-aliased edges. ' +
        'Output a transparent background (alpha channel). Do not invent new background. Do not crop the subject. ' +
        'Return only the subject on transparent background. PNG output.';
    } else if (mode === 'upscale') {
      finalPrompt = 'Upscale this image. Increase resolution and sharpness, recover fine detail, reduce noise and compression artifacts. Do not change the composition, colors, or content.';
      // For upscale, request a larger output
      imageSize = imageSize || '4K';
    } else if (mode === 'stylize') {
      finalPrompt = (prompt || 'Apply a polished editorial design style.') + ' Preserve the subject and composition. Do not add or remove objects.';
    } else if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt is required for edit mode' });
    }

    const thinkingLevel = ALLOWED_THINKING.includes(body.thinkingLevel) ? body.thinkingLevel : 'minimal';

    const payload = {
      contents: [{
        parts: [
          { text: finalPrompt },
          { inlineData: { mimeType: img.mime, data: img.data } },
        ],
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        thinkingConfig: { thinkingLevel },
        // Only include responseFormat if caller requested a specific size.
        // Omitting it lets the model match the input image's dimensions.
        ...(imageSize ? { responseFormat: { image: { imageSize } } } : {}),
      },
    };

    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[edit] Gemini error', upstream.status, errText);
      const msg = extractErrorMessage(errText) || `Gemini API ${upstream.status}`;
      return res.status(upstream.status).json({
        ok: false,
        error: msg,
        upstreamStatus: upstream.status,
      });
    }

    const data = await upstream.json();
    const part = findImagePart(data);

    if (!part) {
      const blocked = data?.promptFeedback?.blockReason;
      if (blocked) {
        return res.status(400).json({ ok: false, error: `Blocked: ${blocked}. Try a different prompt.`, blockReason: blocked });
      }
      const finishReason = data?.candidates?.[0]?.finishReason;
      console.error('[edit] No image returned', { finishReason });
      return res.status(502).json({
        ok: false,
        error: 'Model returned no image. The prompt may have been filtered, or your project does not have access to Nano Banana 2.',
        finishReason,
      });
    }

    const mime = part.inlineData.mimeType || 'image/png';
    return res.status(200).json({
      ok: true,
      image: `data:${mime};base64,${part.inlineData.data}`,
      mime,
      model: MODEL,
    });
  } catch (err) {
    console.error('[edit] Handler crash:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}

function parseImageInput(image) {
  if (typeof image === 'string') {
    const m = image.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mime: m[1], data: m[2] };
  }
  if (image && typeof image === 'object' && image.data) {
    return { mime: image.mime || 'image/png', data: image.data };
  }
  return null;
}

function findImagePart(data) {
  // Skip thinking-mode interim "thought images"; use the final inline image.
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
