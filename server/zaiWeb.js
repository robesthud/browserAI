/**
 * zaiWeb.js — Z.ai (chat.z.ai) web chat integration
 *
 * Routes chat requests to Z.ai using managed session cookies.
 * Falls back to local glm-free-api proxy when cookies are not configured.
 *
 * Z.ai web API uses OAuth session cookies for auth.
 * The chat endpoint returns SSE streaming responses.
 */

import { getCookieHeader, isSessionValid, getSessionState } from "./zaiTokenRefresher.js";

const ZAI_BASE = "https://chat.z.ai";
const GLM_PROXY = process.env.GLM_PROXY_URL || "http://glm-free-api:8000";

export function isZaiWebUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    if (u.hostname === "open.bigmodel.cn" || u.hostname === "api.z.ai") return false;
    return (
      u.hostname === "chat.z.ai" ||
      u.hostname === "chatglm.cn" ||
      u.hostname.endsWith(".chatglm.cn")
    );
  } catch {
    return false;
  }
}

/**
 * Handle a Z.ai web chat request.
 * If we have managed cookies → use them for direct API access.
 * Otherwise → proxy through glm-free-api container.
 */
export async function handleZaiWebChat({ reqBody, onTextDelta }) {
  const {
    model = "glm-4.6",
    messages = [],
    temperature = 0.7,
    stream = true,
  } = reqBody || {};

  const hasCookies = isSessionValid();

  if (hasCookies) {
    return handleDirectZaiChat({ model, messages, temperature, stream, onTextDelta });
  }

  // Fallback: use local GLM proxy
  return handleProxyChat({ model, messages, temperature, stream, onTextDelta });
}

async function handleDirectZaiChat({ model, messages, temperature, stream, onTextDelta }) {
  const cookieHeader = getCookieHeader();

  const body = {
    model: model,
    messages: messages,
    temperature: Math.max(0, Math.min(1, temperature)),
    stream: stream,
    chat_id: "browserai_" + Date.now(),
  };

  const resp = await fetch(ZAI_BASE + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": stream ? "text/event-stream" : "application/json",
      "Cookie": cookieHeader,
      "Origin": ZAI_BASE,
      "Referer": ZAI_BASE + "/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(function() { return ""; });
    throw new Error("Z.ai HTTP " + resp.status + ": " + errText.slice(0, 300));
  }

  if (!stream) {
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || data?.data?.content || "";
    if (onTextDelta) onTextDelta(content);
    return { text: content, toolCalls: [], usage: data?.usage || null };
  }

  // Stream SSE response
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta?.content || parsed?.data?.content || "";
        if (delta && onTextDelta) {
          onTextDelta(delta);
          fullText += delta;
        }
      } catch {}
    }
  }

  return { text: fullText, toolCalls: [], usage: null };
}

async function handleProxyChat({ model, messages, temperature, stream, onTextDelta }) {
  const body = {
    model: model,
    messages: messages,
    temperature: Math.max(0, Math.min(1, temperature)),
    stream: stream,
  };

  const resp = await fetch(GLM_PROXY + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(function() { return ""; });
    throw new Error("GLM proxy HTTP " + resp.status + ": " + errText.slice(0, 300));
  }

  if (!stream) {
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    if (onTextDelta) onTextDelta(content);
    return { text: content, toolCalls: [], usage: data?.usage || null };
  }

  // Stream SSE
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta?.content || "";
        if (delta && onTextDelta) { onTextDelta(delta); fullText += delta; }
      } catch {}
    }
  }
  return { text: fullText, toolCalls: [], usage: null };
}
