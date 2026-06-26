/**
 * modelCatalog.js — unified, deduplicated list of WORKING GLM flash models
 * across both providers (z.ai coding plan + bigmodel.cn / Zhipu).
 *
 * Rules:
 *  - A model is included only if a tiny live probe currently succeeds.
 *  - Duplicates (same model id on both providers) are collapsed to ONE entry,
 *    preferring whichever provider currently answers (not overloaded).
 *  - Results are cached for 1 hour to avoid probing on every request.
 *
 * Exposed: getAvailableModels({ force }) -> { models:[...], checkedAt, cached }
 */

const ZAI_KEY = () => process.env.ZAI_API_KEY || "";
const BIGMODEL_KEY = () => process.env.BIGMODEL_API_KEY || "";

const ZAI_BASE = "https://api.z.ai/api/coding/paas/v4";
const BIGMODEL_BASE = "https://open.bigmodel.cn/api/paas/v4";

// Candidate models per provider (free-tier flash family).
// label/kind drive UI grouping; only ones that PROBE OK are returned.
const CANDIDATES = [
  // provider id, model id, kind, human label.
  // ORDER MATTERS: first working entry becomes the default. glm-4.5-flash is the
  // most reliable agent model (best instruction-following), so it leads.
  { provider: "bigmodel", base: BIGMODEL_BASE, key: BIGMODEL_KEY, id: "glm-4.5-flash", kind: "text", label: "GLM-4.5-Flash" },
  { provider: "zai", base: ZAI_BASE, key: ZAI_KEY, id: "GLM-4.7-Flash", kind: "text", label: "GLM-4.7-Flash" },
  { provider: "bigmodel", base: BIGMODEL_BASE, key: BIGMODEL_KEY, id: "glm-4-flash", kind: "text", label: "GLM-4-Flash" },
  { provider: "bigmodel", base: BIGMODEL_BASE, key: BIGMODEL_KEY, id: "glm-z1-flash", kind: "reasoning", label: "GLM-Z1-Flash (reasoning)" },
  { provider: "bigmodel", base: BIGMODEL_BASE, key: BIGMODEL_KEY, id: "glm-4v-flash", kind: "vision", label: "GLM-4V-Flash (vision)" },
  { provider: "bigmodel", base: BIGMODEL_BASE, key: BIGMODEL_KEY, id: "glm-4.1v-thinking-flash", kind: "vision", label: "GLM-4.1V-Thinking-Flash (vision+reasoning)" },
  // z.ai fallback for glm-4.5-flash if bigmodel is down (deduped at runtime).
  { provider: "zai", base: ZAI_BASE, key: ZAI_KEY, id: "glm-4.5-flash", kind: "text", label: "GLM-4.5-Flash" },
];

let _cache = { models: [], checkedAt: 0 };
const TTL_MS = 60 * 60 * 1000; // 1 hour

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probeOnce(cand, timeoutMs) {
  const key = cand.key();
  if (!key) return { ok: false, reason: "no-key" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(cand.base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cand.id,
        messages: [{ role: "user", content: "hi" }],
        // reasoning/vision models burn tokens on <think>; give enough headroom
        // so the response still contains a valid choices object.
        max_tokens: 32,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    if (r.ok && text.includes('"choices"')) return { ok: true };
    if (text.includes("1113")) return { ok: false, reason: "no-balance", retryable: false };
    if (text.includes("1211")) return { ok: false, reason: "unknown", retryable: false };
    if (text.includes("1220")) return { ok: false, reason: "forbidden", retryable: false };
    if (text.includes("1305")) return { ok: false, reason: "overloaded", retryable: true };
    if (text.includes("1302")) return { ok: false, reason: "rate-limit", retryable: true };
    return { ok: false, reason: "http-" + r.status, retryable: r.status === 429 };
  } catch (e) {
    return { ok: false, reason: (e && e.name === "AbortError") ? "timeout" : "error", retryable: true };
  } finally {
    clearTimeout(t);
  }
}

// Probe with one retry on transient errors (overload / rate-limit / timeout).
async function probe(cand, timeoutMs = 15000) {
  let res = await probeOnce(cand, timeoutMs);
  if (!res.ok && res.retryable) {
    await sleep(1500);
    res = await probeOnce(cand, timeoutMs);
  }
  return res;
}

/**
 * Probe all candidates, dedupe by model id (case-insensitive), preferring the
 * provider that currently answers. Returns unique working models.
 */
export async function getAvailableModels({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache.models.length && now - _cache.checkedAt < TTL_MS) {
    return { models: _cache.models, checkedAt: _cache.checkedAt, cached: true };
  }

  // Sequential probing with small gaps: probing all at once triggers per-account
  // rate-limits (1302) on reasoning models and gives false negatives.
  const results = [];
  for (const c of CANDIDATES) {
    results.push({ cand: c, res: await probe(c) });
    await sleep(400);
  }

  // Dedupe by normalized model id; keep first working provider.
  const byId = new Map();
  for (const { cand, res } of results) {
    if (!res.ok) continue;
    const norm = cand.id.toLowerCase();
    if (byId.has(norm)) continue; // already have a working source for this model
    byId.set(norm, {
      id: cand.id,
      label: cand.label,
      kind: cand.kind,
      provider: cand.provider,
      baseUrl: cand.base,
    });
  }

  const models = Array.from(byId.values());
  _cache = { models, checkedAt: now };
  return { models, checkedAt: now, cached: false };
}

/** Return the provider config (baseUrl + apiKey) for a given model id. */
export function resolveModelProvider(modelId) {
  const norm = String(modelId || "").toLowerCase();
  const hit = (_cache.models || []).find((m) => m.id.toLowerCase() === norm);
  if (!hit) return null;
  const key = hit.provider === "zai" ? ZAI_KEY() : BIGMODEL_KEY();
  return { baseUrl: hit.baseUrl, apiKey: key, model: hit.id, provider: hit.provider, kind: hit.kind };
}

export default { getAvailableModels, resolveModelProvider };
