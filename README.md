# BLCK. — Industrialized Design Studio

> Vercel-deployable. Gemini-powered. Full PSD parsing. Real-time collaboration. Brand kits. Cloud sync.

![status](https://img.shields.io/badge/status-production-FF5949)
![runtime](https://img.shields.io/badge/runtime-Node%2020-0A0A0A)
![ai](https://img.shields.io/badge/AI-Nano%20Banana%202-5b8def)

---

## Quick deploy (3 minutes)

```bash
unzip blck-vercel.zip && cd blck-vercel-v3-final
npm i -g vercel
vercel link               # accept defaults, new project
vercel env add GEMINI_API_KEY    # paste your key from https://aistudio.google.com/apikey
vercel deploy --prod
```

You'll get a live URL. The base app — editor, PSD parsing, templates, brand kits, AI generation, AI editing — works at this point.

**Want cloud accounts + collaboration?** Add the optional setup below.

---

## Troubleshooting

### Check what's configured

Visit `https://YOUR_DEPLOYMENT.vercel.app/api/diag` in your browser. It shows:

- Which environment variables are set (booleans only, never values)
- Whether each API key actually works (Gemini, Pexels, Pixabay, Unsplash)
- Which app features are currently available
- Specific suggestions for what to fix

There's also a `DIAGNOSTICS` link in the footer of the app for quick access.

### Common issues

**"Gemini error — Server missing GEMINI_API_KEY"**
- Add `GEMINI_API_KEY` under Vercel project → Settings → Environment Variables
- Make sure you redeploy after adding it (env vars are read at function start)
- Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

**"Generate failed — 404 / model not found" or diag shows `hasNanoBanana2: false`**
- Your API key exists but doesn't have access to `gemini-3.1-flash-image-preview` (Nano Banana 2)
- Nano Banana 2 is a preview model — most accounts get access automatically, but free-tier projects may need billing enabled at [aistudio.google.com/billing](https://aistudio.google.com/billing)
- Once enabled, the free quota of 10 images/day still applies for cost-free testing

**"Generate failed — 403 Forbidden"**
- Same root cause as 404: your project doesn't have permission for the preview image model
- Enable billing on the Google AI Studio project

**"Smart layout: Gemini API 404"**
- You're hitting the old `gemini-2.0-flash` model which shuts down June 1, 2026
- Make sure you're using the latest build — it uses `gemini-2.5-flash` for layout

**"Smart layout: Model returned no image" or "no response"**
- Your API key may not have access to image generation. Image generation requires a project with billing enabled (free-tier exhausts daily quickly)
- For text-only Smart Layout, the free tier of `gemini-2.5-flash` is generous

**"Smart layout error 429"**
- You've hit the rate limit. Wait a minute and try again. If frequent, enable billing on your Google AI Studio project.

**"Stock photos: No source configured"**
- Add at least one of `PEXELS_API_KEY`, `PIXABAY_API_KEY`, or `UNSPLASH_ACCESS_KEY`
- Pexels and Pixabay sign-up gives an instant key
- The Stock tab still loads — it just tells you to configure a source

### Forced redeploy after adding env vars

Vercel doesn't always rebuild when only env vars change. Force a redeploy:

```bash
vercel deploy --prod --force
```

Or in the dashboard: Deployments → ... → Redeploy → "Use existing build cache" off.

---

## Optional: enable cloud accounts (5 more minutes)

### 1. Add Postgres

In your Vercel project: **Storage → Create Database → Postgres**. Vercel sets `POSTGRES_URL` automatically.

### 2. Add Resend for magic-link email

Sign up at [resend.com](https://resend.com), generate an API key, then:

```bash
vercel env add RESEND_API_KEY
vercel env add MAIL_FROM        # e.g. "BLCK Studio <noreply@yourdomain.com>"
```

### 3. Add a session secret

```bash
# Generate a strong secret
openssl rand -hex 32 | vercel env add AUTH_SECRET
```

### 4. Redeploy

```bash
vercel deploy --prod
```

Done. The app now shows a "LOCAL ONLY" → click → sign-in modal. Users get a magic-link email, click it, land back signed in, and their projects sync.

If you skip steps 1–3, the app still works perfectly in local-only mode. The sign-in button just tells the user to use the local browser version.

---

## Features

### Photoshop import — full fidelity

Drop a `.psd` file into the import dialog. The parser walks the entire layer tree and extracts each layer into the most editable form possible:

- **Text layers → editable Studio text elements** with the original font name (mapped to web equivalent), size, weight, italic, fill color, alignment, letter-spacing. You can re-edit the actual string.
- **Vector shape layers → editable Studio path elements** with anchor points extracted from the Photoshop Bezier knots, plus the original fill color and stroke. You can drag the points and change the colors.
- **Raster layers → image elements** with their canvas rasterized to PNG.
- **All 28 Photoshop blend modes** mapped to CSS `mix-blend-mode` (multiply, screen, overlay, color-burn, soft-light, hue, luminosity, all of them).
- **Layer effects** — drop shadow, outer glow, and stroke are translated to CSS `filter: drop-shadow(...)` and `outline`.
- **Groups** flatten into named layers (`GroupName / Sublayer`). Group opacity, visibility, and blend mode propagate to children.
- **Layer masks** are composited into the layer canvas before extraction.

The import dialog shows a breakdown by category — "5 editable text, 8 vector shapes, 12 raster, 2 skipped" — so you know exactly what came through.

### Stock photos (Pexels · Pixabay · Unsplash)

The **Stock** tab in the left panel searches free, royalty-free photo libraries through a unified `/api/stock` endpoint. One search, three sources, interleaved results.

| Source | Free tier | Setup |
|---|---|---|
| **Pexels** | 200/hr · 20,000/month | Sign up at [pexels.com/api](https://www.pexels.com/api/) — instant key |
| **Pixabay** | 100/min (very generous) | Sign up at [pixabay.com/api/docs](https://pixabay.com/api/docs/) — instant key |
| **Unsplash** | 50/hr demo · 5,000/hr after approval | Register an app at [unsplash.com/developers](https://unsplash.com/developers) |

Configure any combination in Vercel env vars:

```
PEXELS_API_KEY=...
PIXABAY_API_KEY=...
UNSPLASH_ACCESS_KEY=...
```

If only one is set, only that source shows. If none are set, the Stock tab tells the user to configure at least one.

**Attribution handled automatically:**
- Each placed image stores `attribution: {source, photographer, photographerUrl, sourceUrl}` on the element
- The inspector panel shows a credit card with linked photographer + source when the image is selected
- The Unsplash download_location ping fires automatically on placement (per their TOS)
- Unsplash links carry the required `utm_source=blck_studio&utm_medium=referral` parameters

**Server-side proxy** means your user's browser never sees the API keys. One key serves all users within the free tier. Vercel's edge cache holds search results for 1 hour with stale-while-revalidate for 24 hours, dramatically reducing API calls.

### Smart Layout (every new artboard, AI-designed)

When you add a new artboard, Gemini analyzes the master design and produces a layout tailored to the new ratio — instead of just proportionally squishing it. A 1080×1080 square turned into a 1080×1920 Story doesn't just become a stretched mess: backgrounds extend to fill, headlines get repositioned for the taller canvas, CTAs stay tappable, and text resizes to read well at the new size.

How it works:

1. You add an artboard. The app first does a proportional fit so you have a working layout immediately.
2. A "GEMINI · LAYOUT" badge appears on the new artboard.
3. The master design (positions, sizes, roles, font sizes, text content) is sent as compact JSON to `/api/layout`.
4. `gemini-2.0-flash` returns new x/y/w/h (and fontSize for text) for every element under a strict response schema.
5. The client validates, clamps to canvas bounds, drops hallucinated ids, and applies the result.
6. If anything fails (API error, model timeout, no API key), the proportional fit silently stays in place.

The toggle lives in the ratio picker. Default is **ON**.

Re-run the layout pass on any existing artboard via the artboard context menu → **Redesign with AI**.

### Gemini AI · Nano Banana 2

Image generation is powered by **Nano Banana 2** (model ID `gemini-3.1-flash-image-preview`), Google's latest image model launched February 2026. It currently ranks #1 on the Artificial Analysis Image Arena leaderboard for text-to-image.

Server-side serverless functions keep your API key safe.

- `/api/generate` — text → image
  - 14 aspect ratios including new ultra-wide and ultra-tall: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `1:4`, `4:1`, `1:8`, `8:1`
  - 4 resolutions: `512`, `1K` (default), `2K`, `4K`
  - 2 thinking levels: `minimal` (default, fastest) or `high` (better quality on complex prompts)
  - Optional transparent background mode for sticker/asset use
- `/api/edit` — image + text → image with 4 modes:
  - `edit` — natural-language image editing
  - `remove-bg` — background removal with transparent alpha
  - `upscale` — automatic 4K upgrade
  - `stylize` — apply a design style while preserving subject

The browser never sees the API key. All generated images include Google's SynthID invisible watermark for provenance.

**Pricing** (per Google's billing page):
- 1K / 2K image: ~$0.067
- 4K image: ~$0.12
- Free tier on Google AI Studio includes 10 images/day; beyond that requires billing enabled.

### Templates

Six starter designs on the landing page: minimal poster, social quote card, event hero, product card, lookbook spread, and blank. Each template instantiates a fully editable Studio project. If a group with a brand kit is active, the template uses the kit's colors and fonts.

### Brand kits

Each project group can have a brand kit attached:

- **Palette** — unlimited custom colors (click to edit, right-click to remove)
- **Fonts** — multi-select from available web fonts
- **Logos** — up to 6 uploaded images, stored as base64

Templates and new artboards inherit the active group's kit. Open a group's context menu → "Change color" to access the editor.

### Real-time collaboration

Click the **Solo** button in the editor toolbar → **Start live session**. Anyone with the share URL joins peer-to-peer over WebRTC. Cursors, presence dots, and color identification work out of the box. The signaling servers are public (provided by `y-webrtc`), so no Vercel infrastructure is needed for collab.

> Note: cursors and presence sync are fully working. Deep structural sync of the document tree is wired into a Yjs document for future expansion — see the code comments in the `startCollab` function. Today, collaborators should use cloud sync (auto-saves every 2 seconds when signed in) to share document updates.

### Cloud sync

When signed in, every change auto-syncs to Postgres after a 2-second debounce. Open the app on another device, sign in with the same email, and your projects appear. Local-only projects (created while signed out) merge in on next sign-in — latest-modified wins per project ID.

### Custom ratios

Add artboard → **Custom...** opens a proper modal with width/height inputs, 8 quick-aspect cards (1:1, 4:5, 9:16, 16:9, 21:9, A4...), aspect-lock toggle, live mini-preview, and a gcd-computed ratio display.

### Project organization

- **Folders** — classic nested folder navigation
- **Groups** — color-coded tags with brand kits. 5 default groups (Brand, Social, Web, Print, Event) seeded on first run; create your own with custom colors.
- **Filter chips** — switch between groups at the top of the projects grid

---

## Architecture

```
blck-vercel-v3-final/
├── api/
│   ├── generate.js              POST  Gemini text → image
│   ├── edit.js                  POST  Gemini image → image
│   ├── sync.js                  GET   load user's full snapshot
│   │                            PUT   save user's full snapshot
│   └── auth/
│       ├── login.js             POST  send magic-link email
│       ├── verify.js            GET   claim magic-link token
│       ├── me.js                GET   current session
│       └── logout.js            POST  clear session
├── lib/
│   └── auth.js                  JWT, cookies, Postgres helpers, Resend
├── public/
│   └── index.html               Single-file frontend (~220KB)
├── package.json                 Node 20, @vercel/postgres
├── vercel.json                  Function config + headers
├── .env.local.example
└── README.md
```

**Frontend:** one HTML file. CDN-loaded libraries: JSZip, ag-psd (PSD parser), Yjs + y-webrtc (lazy-loaded only when collab starts). No build step.

**Backend:** plain Vercel Node serverless functions. ESM (`type: module`). Uses `@vercel/postgres` for cloud data and the `fetch` API for Gemini and Resend.

**Auth:** JWT in HTTP-only cookies. HS256, no JWT library — `crypto.createHmac` + constant-time compare. Magic links are random 32-byte hex tokens stored in `magic_links` with a 15-minute expiry and one-shot `used` flag (claimed via atomic `UPDATE ... RETURNING`).

**Sync:** "blob endpoint" — the client sends the whole user snapshot on every change (debounced 2s). Simple, correct, last-write-wins per user. Vercel's 4.5MB body limit caps the snapshot size.

---

## API reference

### `POST /api/generate`

```json
{
  "prompt": "a metallic 3D star burst, gold, studio lighting",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "thinkingLevel": "minimal",
  "transparent": true
}
```

Returns `{ ok: true, image: "data:image/png;base64,...", model: "gemini-3.1-flash-image-preview", aspectRatio, imageSize }`.

- `aspectRatio` (default `"1:1"`) — one of `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `1:4`, `4:1`, `1:8`, `8:1`
- `imageSize` (default `"1K"`) — `"512"`, `"1K"`, `"2K"`, or `"4K"`
- `thinkingLevel` (default `"minimal"`) — `"minimal"` for speed, `"high"` for quality on complex prompts
- `transparent` (default `false`) — prompts the model for a transparent background (sticker/asset mode)

### `POST /api/edit`

```json
{
  "image": "data:image/png;base64,...",
  "prompt": "make the lighting more dramatic",
  "mode": "edit",
  "imageSize": "2K",
  "thinkingLevel": "minimal"
}
```

Mode is `edit`, `remove-bg`, `upscale`, or `stylize`. The `upscale` mode automatically requests `imageSize: "4K"` unless overridden.

### `POST /api/layout`

```json
{
  "master": {
    "width": 1080, "height": 1080,
    "elements": [
      {"id":"el1","type":"shape","x":0,"y":0,"w":1080,"h":1080,"role":"background"},
      {"id":"el2","type":"text","x":80,"y":300,"w":920,"h":200,"text":"Bold statement.","fontSize":200,"role":"headline"}
    ]
  },
  "target": {"width": 1080, "height": 1920, "name": "Story"}
}
```

Returns `{ok:true, elements:[{id, x, y, w, h, fontSize?}], rationale?}`. Uses `gemini-2.0-flash` with a strict response schema. The client validates, clamps, and drops malformed entries.

### `GET /api/stock?q=...&source=all|pexels|pixabay|unsplash&orientation=&page=1`

Unified stock photo search. Returns:

```json
{
  "ok": true,
  "query": "mountains",
  "total": 12500,
  "photos": [{
    "id": "pexels-12345",
    "source": "pexels",
    "width": 4000, "height": 6000,
    "url": "...", "thumb": "...", "preview": "...",
    "avgColor": "#7a8b9c",
    "alt": "Snowy mountain at sunset",
    "photographer": {"name":"Jane Doe","url":"..."},
    "sourceUrl": "...",
    "downloadPing": null
  }],
  "attribution": {...},
  "sources": [{"source":"pexels","ok":true,"count":20},...]
}
```

### `POST /api/stock-use`

```json
{ "downloadPing": "https://api.unsplash.com/photos/.../download" }
```

Fires Unsplash's required download notification when a user places an Unsplash photo. Fire-and-forget — does not block.

### `POST /api/auth/login`

```json
{ "email": "you@example.com" }
```

Returns `{ ok: true }` and sends a magic-link email. In dev mode (no `RESEND_API_KEY`), returns `{ ok: true, devMode: true, link: "..." }`.

### `GET /api/auth/verify?token=...`

Claims the magic-link token, sets a session cookie, redirects to `/?signedin=1`.

### `GET /api/auth/me`

Returns `{ ok: true, signedIn: true, user: { id, email } }` or `401`.

### `POST /api/auth/logout`

Clears the session cookie.

### `GET /api/sync`

Returns `{ ok: true, projects: [...], folders: [...], groups: [...] }` for the signed-in user.

### `PUT /api/sync`

Body: `{ projects, folders, groups }`. Replaces all user data with the snapshot. 4MB cap.

---

## Costs

- **Nano Banana 2 (Gemini 3.1 Flash Image Preview):** ~$0.067 per 1K/2K image, ~$0.12 per 4K image. Free tier (10/day on AI Studio) covers casual use. Smart Layout uses `gemini-2.5-flash` (text only) at fractions of a cent per call.
- **Vercel:** Hobby tier covers all serverless functions; Pro starts at $20/mo if you exceed bandwidth.
- **Postgres:** Vercel's Hobby Postgres is free up to 256 MB storage and 60 hours/month compute.
- **Resend:** 3,000 emails/month free.

For most personal use, total cost is **$0/month** plus pennies-to-dollars for Gemini depending on volume.

---

## Security

- Gemini API key is server-only via `process.env.GEMINI_API_KEY` — never exposed to the browser
- Sessions are JWTs in `HttpOnly`, `Secure`, `SameSite=Lax` cookies — XSS can't read them
- Magic links are single-use (atomic UPDATE) with 15-minute TTL
- HMAC signatures use constant-time comparison (`crypto.timingSafeEqual`)
- Image input to `/api/edit` is capped at 15 MB decoded
- Prompt input is capped at 4000 chars
- Sync payload is capped at 4 MB
- All AI-generated images carry an invisible SynthID watermark from Google

---

## Local development

```bash
cp .env.local.example .env.local
# Fill in GEMINI_API_KEY at minimum
vercel dev
```

Static HTML in `public/` — edit and refresh, no rebuild.

To test cloud features locally, also fill in `POSTGRES_URL`, `RESEND_API_KEY`, `MAIL_FROM`, and `AUTH_SECRET`.

---

## License

Application code: do whatever you want with it. Font Awesome icons are CC BY 4.0. Gemini calls are subject to [Google's terms](https://ai.google.dev/gemini-api/terms).
