/**
 * POST /api/generate
 *
 * Body:
 *   { prompt: string, aspectRatio?: "1:1"|"16:9"|"9:16"|"4:3"|"3:4"|"21:9"|"3:2"|"2:3"|"5:4"|"4:5", transparent?: boolean }
 *
 * Response:
 *   { ok: true, image: "data:image/png;base64,...", mime: "image/png" }
 *   { ok: false, error: "..." }
 *
 * Uses Gemini 2.5 Flash Image (Nano Banana) via generateContent REST endpoint.
 * Auth via x-goog-api-key — key NEVER exposed to client.
 */

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ALLOWED_RATIOS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];

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
    const prompt = String(body.prompt || '').trim();
    const aspectRatio = body.aspectRatio && ALLOWED_RATIOS.includes(body.aspectRatio)
      ? body.aspectRatio
      : '1:1';
    const transparent = Boolean(body.transparent);

    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt is required' });
    }
    if (prompt.length > 4000) {
      return res.status(400).json({ ok: false, error: 'prompt too long (max 4000 chars)' });
    }

    // Coax transparent background through prompting when requested.
    // Gemini doesn't have a strict transparent flag, but it follows clear instructions.
    let finalPrompt = prompt;
    if (transparent) {
      finalPrompt =
        `${prompt}\n\nCRITICAL: Render on a fully transparent background. ` +
        `No backdrop, no scene, no surface, no shadow on a ground. ` +
        `The subject must be isolated as a clean cutout, suitable for use as a PNG sticker or design asset. ` +
        `Edges must be clean. Output must be ready to composite over any background.`;
    }

    const payload = {
      contents: [
        { parts: [ { text: finalPrompt } ] }
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio }
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
      console.error('Gemini error:', upstream.status, errText);
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
    console.error('Handler error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
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
