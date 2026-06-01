/**
 * Shared app state in KV — reflected for ALL users (not per-browser):
 *   shared:history   -> conversation history (capped)
 *   shared:prompts   -> { system, userTemplate }
 *
 * Reuses the RATELIMIT KV binding (keys namespaced under shared:*).
 * POST /api/state  { password, op: "load" | "savePrompts" | "clearHistory", ... }
 */

export const HIST_KEY = "shared:history";
export const PROMPTS_KEY = "shared:prompts";
const HIST_CAP = 100;
const PROMPT_MAX = 4000;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  if (!env.APP_PASSWORD || body.password !== env.APP_PASSWORD) {
    return json({ error: "Unauthorized." }, 401);
  }
  if (!env.RATELIMIT) {
    return json({ error: "Shared storage not configured." }, 503);
  }

  try {
    switch (body.op) {
      case "load": {
        const history = safeParse(await env.RATELIMIT.get(HIST_KEY), []);
        const prompts = safeParse(await env.RATELIMIT.get(PROMPTS_KEY), null);
        return json({ history, prompts });
      }
      case "savePrompts": {
        const system = String(body.system || "").slice(0, PROMPT_MAX);
        const userTemplate = String(body.userTemplate || "");
        if (!userTemplate.includes("{question}") || !userTemplate.includes("{excerpts}")) {
          return json({ error: "Retrieval prompt must keep {question} and {excerpts}." }, 400);
        }
        await env.RATELIMIT.put(
          PROMPTS_KEY,
          JSON.stringify({ system, userTemplate: userTemplate.slice(0, PROMPT_MAX) })
        );
        return json({ ok: true });
      }
      case "clearHistory": {
        await env.RATELIMIT.put(HIST_KEY, "[]");
        return json({ ok: true });
      }
      default:
        return json({ error: "Unknown op." }, 400);
    }
  } catch (e) {
    return json({ error: "Storage error: " + e.message }, 502);
  }
}

function safeParse(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
