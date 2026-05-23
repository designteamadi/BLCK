/**
 * POST /api/edit
 *
 * Body:
 *   {
 *     prompt: string,
 *     image: "data:image/...;base64,..." | { mime: string, data: string },
 *     mode?: "edit" | "remove-bg" | "upscale" | "stylize"
 *   }
 *
 * Response:
 *   { ok: true, image: "data:image/png;base64,...", mime: "image/png" }
 *   { ok: false, error: "..." }
 *
 * Uses Gemini 2.5 Flash Image for natural-language image editing.
 */

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB upper bound; 20MB total request limit

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
    let { prompt = '', image, mode = 'edit' } = body;
    prompt = String(prompt).trim();

    if (!image) {
      return res.status(400).json({ ok: false, error: 'image is required' });
    }

    // Normalize image to { mime, data }
    const img = parseImageInput(image);
    if (!img) {
      return res.status(400).json({ ok: false, error: 'invalid image format' });
    }

    // Decode size check
    const approxBytes = (img.data.length * 3) / 4;
    if (approxBytes > MAX_IMAGE_BYTES) {
      return res.status(413).json({ ok: false, error: 'image too large (max ~15 MB decoded)' });
    }

    // Build prompt by mode
    let finalPrompt = prompt;
    if (mode === 'remove-bg') {
      finalPrompt =
        'Remove the background from this image completely. Keep the main subject perfectly intact with clean, anti-aliased edges. ' +
        'Output a transparent background (alpha channel). Do not invent new background. Do not crop the subject. ' +
        'Return only the subject on transparent background. PNG output.';
    } else if (mode === 'upscale') {
      finalPrompt = 'Upscale this image. Increase resolution and sharpness, recover fine detail, reduce noise and compression artifacts. Do not change the composition, colors, or content.';
    } else if (mode === 'stylize') {
      finalPrompt = (prompt || 'Apply a polished editorial design style.') + ' Preserve the subject and composition. Do not add or remove objects.';
    } else if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt is required for edit mode' });
    }

    const payload = {
      contents: [{
        parts: [
          { text: finalPrompt },
          { inlineData: { mimeType: img.mime, data: img.data } }
        ]
      }],
      generationConfig: {
        responseModalities: ['IMAGE']
      }
    };

    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('Gemini edit error:', upstream.status, errText);
      return res.status(upstream.status).json({
        ok: false,
        error: extractErrorMessage(errText) || `Gemini API error (${upstream.status})`
      });
    }

    const data = await upstream.json();
    const part = findImagePart(data);

    if (!part) {
      const blocked = data?.promptFeedback?.blockReason;
      if (blocked) {
        return res.status(400).json({ ok: false, error: `Blocked: ${blocked}. Try a different prompt.` });
      }
      return res.status(502).json({ ok: false, error: 'No image returned from model' });
    }

    const mime = part.inlineData.mimeType || 'image/png';
    const dataUrl = `data:${mime};base64,${part.inlineData.data}`;
    return res.status(200).json({ ok: true, image: dataUrl, mime });
  } catch (err) {
    console.error('Edit handler error:', err);
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
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p.inlineData?.data) return p;
    if (p.inline_data?.data) return { inlineData: p.inline_data };
  }
  return null;
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message;
  } catch (e) { return null; }
}
