/**
 * Cloudflare Pages Function — POST /api/ask
 *
 * Public RAG endpoint over the RocsysContent Weaviate collection:
 *   password gate → Weaviate hybrid search (REST/GraphQL) → Claude synthesis.
 *
 * Secrets (set on the Cloudflare Pages project, NEVER committed):
 *   APP_PASSWORD, WEAVIATE_URL, WEAVIATE_API_KEY, ANTHROPIC_API_KEY
 */

const COLLECTION = "RocsysContent";

// Per-IP cost guard: at most RATE_LIMIT_PER_WINDOW authenticated calls per IP
// per fixed 12-hour window (aligned to UTC 00:00 / 12:00), tracked in KV.
const RL_WINDOW_MS = 12 * 60 * 60 * 1000;
const RL_DEFAULT_CAP = 30;

// Public model allowlist (friendly name -> Anthropic model id). Anything not
// listed falls back to haiku, so a caller can never request an arbitrary model.
const MODELS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

const SYSTEM =
  "You are a research assistant answering questions about Rocsys using ONLY the " +
  "provided numbered excerpts. Write a direct, well-structured answer in your own " +
  "words and cite sources inline as [n] matching the excerpt numbers. Do NOT echo " +
  "or reproduce the excerpts verbatim, and begin with the answer itself. If the " +
  "excerpts do not cover the question, say so plainly.";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // --- server-side password gate (API is unusable without it) ---
  if (!env.APP_PASSWORD || body.password !== env.APP_PASSWORD) {
    return json({ error: "Unauthorized — wrong or missing password." }, 401);
  }

  // --- per-IP rate limit (only authenticated calls count; before any paid call) ---
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const limited = await overRateLimit(env, ip);
  if (limited) {
    return json(
      { error: `Rate limit reached: max ${limited.cap} questions per IP per 12 hours. Try again later.` },
      429,
      { "Retry-After": String(limited.retryAfter) }
    );
  }

  const question = (body.question || "").toString().trim();
  if (!question) return json({ error: "Empty question." }, 400);
  if (question.length > 2000) return json({ error: "Question too long." }, 400);

  // bounded inputs so a single call can't blow up cost
  const k = clamp(parseInt(body.k, 10) || 8, 1, 20);
  const model = MODELS[body.model] || MODELS.haiku;
  const reasoning = body.reasoning === true;

  let hits;
  try {
    hits = await weaviateSearch(env, question, k);
  } catch (e) {
    return json({ error: "Search failed: " + e.message }, 502);
  }
  if (!hits.length) {
    return json({ answer: "No indexed content matched that question.", sources: [] });
  }

  let answer;
  try {
    answer = await synthesize(env, question, hits, model, reasoning);
  } catch (e) {
    return json({ error: "Synthesis failed: " + e.message }, 502);
  }

  return json({ answer, sources: dedupeSources(hits), model: body.model || "haiku" });
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/**
 * Returns null if the IP is under the cap (and records the call), or
 * { cap, retryAfter } if the IP has hit the cap for the current 12h window.
 * No-op (returns null) when KV isn't bound — e.g. local dev — so it never
 * blocks development and a KV hiccup never blocks a legitimate query.
 */
async function overRateLimit(env, ip) {
  if (!env.RATELIMIT || !ip) return null;
  const cap = parseInt(env.RATE_LIMIT_PER_WINDOW, 10) || RL_DEFAULT_CAP;
  const now = Date.now();
  const windowId = Math.floor(now / RL_WINDOW_MS);
  const key = `rl:${ip}:${windowId}`;

  let count = 0;
  try {
    count = parseInt((await env.RATELIMIT.get(key)) || "0", 10);
  } catch {
    return null;
  }
  if (count >= cap) {
    const retryAfter = Math.ceil(((windowId + 1) * RL_WINDOW_MS - now) / 1000);
    return { cap, retryAfter };
  }
  try {
    await env.RATELIMIT.put(key, String(count + 1), {
      expirationTtl: Math.ceil(RL_WINDOW_MS / 1000) + 60, // auto-clean after the window
    });
  } catch {
    /* best-effort increment; don't fail the request on a KV write hiccup */
  }
  return null;
}

async function weaviateSearch(env, question, k) {
  const host = env.WEAVIATE_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const gql =
    `{ Get { ${COLLECTION}(hybrid: {query: ${JSON.stringify(question)}, alpha: 0.5}, ` +
    `limit: ${k}) { url title summary content tags _additional { score } } } }`;

  // The text2vec-weaviate vectorizer occasionally returns a transient 5xx (503).
  // Retry those a couple of times; fail fast on 4xx (auth/bad query).
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(`https://${host}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.WEAVIATE_API_KEY}`,
        // required for text2vec-weaviate to vectorize the query over REST
        "X-Weaviate-Cluster-Url": `https://${host}`,
      },
      body: JSON.stringify({ query: gql }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.errors) throw new Error(data.errors[0]?.message || "GraphQL error");
      const objs = data?.data?.Get?.[COLLECTION] || [];
      return objs.map((o) => ({
        url: o.url,
        title: o.title,
        content: o.content,
        score: o._additional?.score,
      }));
    }
    lastStatus = resp.status;
    if (resp.status < 500) throw new Error(`Weaviate HTTP ${resp.status}`);
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // backoff before retry
  }
  throw new Error(`Weaviate HTTP ${lastStatus} after retries`);
}

async function synthesize(env, question, hits, model, reasoning) {
  const excerpts = hits
    .map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.content}`)
    .join("\n\n");

  const payload = {
    model,
    max_tokens: reasoning ? 6000 : 1800,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Question: ${question}\n\n` +
          `Numbered excerpts (context only — do not repeat them back):\n${excerpts}\n\n` +
          `Now write the answer, citing excerpts inline as [n].`,
      },
    ],
  };
  // extended thinking ("reasoning"). Opus 4.8 uses the newer adaptive-thinking
  // API (type: adaptive + output_config.effort); Sonnet 4.6 / Haiku 4.5 use the
  // older enabled + budget_tokens form. temperature stays unset in both cases.
  if (reasoning) {
    if (model.startsWith("claude-opus-4-8")) {
      payload.thinking = { type: "adaptive" };
      payload.output_config = { effort: "high" };
    } else {
      payload.thinking = { type: "enabled", budget_tokens: 3000 };
    }
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Anthropic HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "(no answer returned)";
}

function dedupeSources(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    out.push({ url: h.url, title: h.title, score: h.score });
  }
  return out;
}
