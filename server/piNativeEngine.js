/**
 * piNativeEngine.js — Native pi-ai streaming engine (hybrid path)
 *
 * Goal: for real cloud providers (OpenAI / Anthropic / Google) use pi-ai's
 * NATIVE `stream()` which performs real, structured tool-calling instead of the
 * text-JSON parsing used by the legacy customStreamFn. Web sessions (DeepSeek /
 * z.ai) and local Ollama keep the legacy path in agentEngine.js.
 *
 * This module exposes:
 *   - isNativeCapableProvider(provider) -> boolean
 *   - buildNativeStreamFn(provider) -> streamFn compatible with pi-agent-core Agent
 *   - toTypeboxTools(piTools) -> Tool[] with typebox parameter schemas
 *
 * It reuses the same Agent + SSE event mapping that agentEngine.js already does,
 * so the UI protocol is unchanged.
 */
import { Type } from "@earendil-works/pi-ai";
import { stream as piStream, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";

// Register pi-ai's built-in API providers (openai/anthropic/google/...) once,
// so native stream() can resolve the implementation for model.api.
let _providersRegistered = false;
function ensureProviders() {
  if (_providersRegistered) return;
  try { registerBuiltInApiProviders(); _providersRegistered = true; }
  catch (e) { /* idempotent; ignore if already registered */ _providersRegistered = true; }
}

/**
 * Decide whether a provider should use the native pi-ai path.
 * Native is used ONLY for first-party cloud APIs reachable with a normal API key.
 * DeepSeek-web, z.ai-web (managed sessions) and local Ollama stay on legacy.
 */
export function isNativeCapableProvider(provider = {}) {
  const url = String(provider.baseUrl || "").toLowerCase();
  const key = String(provider.apiKey || "");
  if (!url || !key || key === "__managed__" || key === "ollama") return false;

  // Exclude managed WEB-session backends (handled by legacy path).
  if (url.includes("chat.deepseek") || url.includes("chat.z.ai")) return false;
  // Exclude local ollama (no native tool-calling reliability on tiny models).
  if (url.includes("ollama") || url.includes("11434") || url.includes("127.0.0.1") || url.includes("localhost")) return false;

  // Allow recognised cloud providers (incl. official z.ai API).
  return (
    url.includes("api.z.ai") ||        // official Z.AI API (GLM models) — native
    url.includes("bigmodel") ||        // Zhipu BigModel endpoint
    url.includes("openai") ||
    url.includes("anthropic") ||
    url.includes("googleapis") ||
    url.includes("generativelanguage") ||
    url.includes("gemini") ||
    url.includes("groq") ||
    url.includes("mistral") ||
    url.includes("openrouter") ||
    url.includes("together") ||
    url.includes("deepseek.com/v1") || // official DeepSeek API (not web)
    url.includes("/v1") // generic OpenAI-compatible cloud endpoint with a real key
  );
}

/** Map a provider baseUrl to a pi-ai api + provider id. */
export function detectApi(baseUrl = "") {
  const u = String(baseUrl).toLowerCase();
  if (u.includes("anthropic")) return { api: "anthropic-messages", provider: "anthropic" };
  if (u.includes("googleapis") || u.includes("generativelanguage") || u.includes("gemini"))
    return { api: "google-completions", provider: "google" };
  if (u.includes("api.z.ai") || u.includes("bigmodel"))
    return { api: "openai-completions", provider: "zai" };
  return { api: "openai-completions", provider: "openai" };
}

/** Build a pi-ai Model object for native streaming. */
export function buildNativeModel(provider = {}) {
  const baseUrl = provider.baseUrl;
  const { api, provider: providerType } = detectApi(baseUrl);
  // Sensible default model id per provider (pi-ai catalog ids).
  let modelId = provider.model;
  if (!modelId) {
    if (providerType === "zai") modelId = "glm-4.7";
    else if (providerType === "anthropic") modelId = "claude-3-5-sonnet-latest";
    else if (providerType === "google") modelId = "gemini-1.5-flash";
    else modelId = "gpt-4o-mini";
  }
  const model = {
    id: modelId,
    name: modelId,
    api,
    provider: providerType,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(provider.contextWindow) || 128000,
    maxTokens: Number(provider.maxTokens) || 4096,
  };
  // z.ai (GLM) needs specific OpenAI-compat overrides for thinking + tool stream.
  if (providerType === "zai") {
    model.input = ["text"];
    model.contextWindow = Number(provider.contextWindow) || 200000;
    model.maxTokens = Number(provider.maxTokens) || 131072;
    model.compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "zai",
      zaiToolStream: true,
    };
  }
  return model;
}

/**
 * Convert a minimal JSON-ish param spec ({ name: { type, required, description } })
 * into a typebox TSchema object accepted by pi-ai tools.
 */
function paramsToTypebox(params = {}) {
  const props = {};
  const required = [];
  for (const [name, meta] of Object.entries(params || {})) {
    const m = meta || {};
    let schema;
    switch (m.type) {
      case "number":
        schema = Type.Number();
        break;
      case "integer":
        schema = Type.Integer();
        break;
      case "boolean":
        schema = Type.Boolean();
        break;
      case "array":
        schema = Type.Array(Type.Any());
        break;
      case "object":
        schema = Type.Object({}, { additionalProperties: true });
        break;
      default:
        schema = Type.String();
    }
    if (m.description) schema = { ...schema, description: m.description };
    props[name] = m.required ? schema : Type.Optional(schema);
    if (m.required) required.push(name);
  }
  return Type.Object(props, { additionalProperties: false });
}

/**
 * Convert BrowserAI wrapped pi tools (name/description/parameters/execute) into
 * pi-ai Tool definitions with typebox parameter schemas. The `execute` handler
 * is preserved on the returned object so pi-agent-core can run it.
 */
export function toTypeboxTools(piTools = []) {
  return piTools.map((t) => ({
    name: t.name,
    description: t.description || t.label || t.name,
    parameters: paramsToTypebox(t.parameters || t.params || {}),
    execute: t.execute,
  }));
}

/**
 * Build a streamFn for pi-agent-core's Agent that delegates to pi-ai native
 * stream(). pi-agent-core calls streamFn(model, context, options) and expects
 * an AssistantMessageEventStream — which pi-ai's stream() returns directly.
 */
export function buildNativeStreamFn(provider = {}) {
  ensureProviders();
  return function nativeStreamFn(model, context, options) {
    const opts = {
      ...(options || {}),
      apiKey: provider.apiKey,
      temperature: provider.temperature != null ? provider.temperature : 0.3,
    };
    if (provider.extraHeaders && Object.keys(provider.extraHeaders).length) {
      opts.headers = { ...(model.headers || {}), ...provider.extraHeaders };
    }
    return piStream(model, context, opts);
  };
}

export default { isNativeCapableProvider, buildNativeStreamFn, toTypeboxTools, buildNativeModel, detectApi };
