# Rocsys Research Assistant — Web App

**Live:** https://rocsys-rag.pages.dev  (password-gated)

A very basic, password-gated public web front end for the Rocsys RAG. Visitors type a
question, pick how many sources (`k`) and which model, optionally toggle reasoning, and
get a cited answer. Backend is a single Cloudflare Pages Function that does
Weaviate hybrid search → Claude synthesis.

```
public/index.html        front end (password screen, query box, k + model pickers, reasoning toggle)
public/vendor/*          marked + DOMPurify, vendored locally (no CDN/supply-chain risk)
functions/api/ask.js     Pages Function: POST /api/ask  (password gate → Weaviate → Claude)
wrangler.toml            Pages project config (no secrets)
.github/workflows/       GitHub Action: auto-deploy to Cloudflare Pages on push to main
```

## Security model

- **Password gate** is enforced **server-side** in `ask.js` — the API returns 401 without
  the correct `APP_PASSWORD`, so the paid endpoint can't be used by just hitting `/api/ask`.
- **No keys in the repo.** All secrets live on the Cloudflare Pages project; the GitHub
  Action only uses GitHub repo secrets to deploy. Never commit real keys.
- The Function only ever queries the **`RocsysContent`** collection — the rest of the
  shared cluster is never exposed.
- Inputs are bounded server-side: `k` clamped 1–20, model restricted to an allowlist
  (`haiku` / `sonnet` / `opus`), question length capped.
- **Per-IP rate limit**: max `RATE_LIMIT_PER_WINDOW` (default 30) authenticated questions
  per IP per fixed 12-hour window (UTC-aligned), tracked in a KV namespace → returns 429
  past the cap. Counts only after the password gate, before any paid call.
- Rendered answer + source titles are sanitized (DOMPurify) / inserted via `textContent`.
- Weaviate queries retry transient 5xx (the vectorizer occasionally 503s).

> Note: a shared password protects against the open internet/bots, but anyone you give the
> password to can run (paid) queries on your account — including Opus with reasoning. Share
> accordingly.

## Secrets to set

**On the Cloudflare Pages project** (Dashboard → your project → Settings → Environment
variables, mark as *Secret*; or via CLI):
```bash
npx wrangler pages secret put APP_PASSWORD      --project-name rocsys-rag   # e.g. jetx
npx wrangler pages secret put WEAVIATE_URL       --project-name rocsys-rag   # 257dyoag….weaviate.cloud
npx wrangler pages secret put WEAVIATE_API_KEY   --project-name rocsys-rag
npx wrangler pages secret put ANTHROPIC_API_KEY  --project-name rocsys-rag
```

**On the GitHub repo** (Settings → Secrets and variables → Actions) — only needed for the
auto-deploy Action:
```
CLOUDFLARE_API_TOKEN     # token with "Cloudflare Pages: Edit"; scope it to THIS account/project, not account-wide
CLOUDFLARE_ACCOUNT_ID
```

The deploy action is pinned to an immutable commit SHA (not a mutable `@v3` tag) for
supply-chain safety; bump the SHA + version comment together when updating.

## Deploy

### Option A — GitHub Action (auto, recommended)
1. Push this `web/` folder to a GitHub repo.
2. Create a Pages project named `rocsys-rag` (one-time): `npx wrangler pages project create rocsys-rag`.
3. Set the Cloudflare secrets (above) on that project, and the two GitHub secrets on the repo.
4. Every push to `main` runs `.github/workflows/deploy.yml` → live at `https://rocsys-rag.pages.dev`.

### Option B — one-off manual deploy
```bash
cd web
npx wrangler pages deploy public --project-name rocsys-rag
```

## Local development
```bash
cd web
printf 'APP_PASSWORD=jetx\nWEAVIATE_URL=...\nWEAVIATE_API_KEY=...\nANTHROPIC_API_KEY=...\n' > .dev.vars  # gitignored
npx wrangler pages dev public
# open the printed localhost URL
```

## API
`POST /api/ask` → `{ question, password, k, model: "haiku"|"sonnet"|"opus", reasoning: bool }`
returns `{ answer, sources: [{url, title, score}], model }`.
