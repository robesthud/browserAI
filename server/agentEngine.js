/**
 * agentEngine.js v5 — BrowserAI pi-agent-core adapter (stability-enhanced)
 *
 * DeepSeek tool integration: prompt injection + JSON parsing + fuzzy matching.
 * Dual-strategy parser: ```json blocks AND bare JSON objects.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isNativeCapableProvider, buildNativeStreamFn, toTypeboxTools, buildNativeModel } from "./piNativeEngine.js";
import { TOOLS } from "./agentTools.js";
import { resolveProviderFromInput } from "./providerResolution.js";
import { withWorkspaceScope, getContainerWorkspaceRoot } from "./workspace.js";
import { callLLMStream } from "./llmClient.js";
import { isDeepSeekWebUrl } from "./deepseekWeb.js";
import { getAvailableModels, resolveModelProvider } from "./modelCatalog.js";

function sse(target, event, data) {
  if (!target || target.destroyed || target.writableEnded) return;
  try { target.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch {}
}
function sseDone(target, meta, tokens) {
  sse(target, "done", { reason: meta?.reason || "complete", ...meta, tokens: tokens || { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: meta?.steps || 0 } });
}
function wrapTool(name, toolDef, loopGuard) {
  var params = toolDef.parameters || toolDef.params || {};
  return {
    name, label: toolDef.label || name, description: toolDef.description || "", parameters: params,
    execute: async function(toolCallId, args, signal, onUpdate) {
      // ── Loop guard: stop web-session models (DeepSeek) from spinning.
      if (loopGuard) {
        // (a) identical tool + identical args repeated → short-circuit.
        var sig;
        try { sig = name + ":" + JSON.stringify(args || {}); } catch (e) { sig = name + ":?"; }
        var n = (loopGuard.get(sig) || 0) + 1;
        loopGuard.set(sig, n);
        if (n >= 2) {
          return { content: [{ type: "text", text: "ALREADY DONE: tool '" + name + "' was already executed with these exact arguments. Do NOT call it again. Proceed to the NEXT step, or finish with a short confirmation and NO tool call." }], details: { loopGuard: true, count: n, alreadyDone: true } };
        }
        // (b) same FILE written/edited more than twice (even with different
        // content) → the model is re-creating the same file in a loop. Stop it.
        if ((name === "write_file" || name === "edit_file") && args && args.path) {
          var pkey = "path:" + String(args.path);
          var pn = (loopGuard.get(pkey) || 0) + 1;
          loopGuard.set(pkey, pn);
          if (pn >= 3) {
            return { content: [{ type: "text", text: "STOP: file '" + args.path + "' has already been written " + (pn - 1) + " times in this task. It is complete. Do NOT write it again. Reply with a short final confirmation and NO tool call." }], details: { loopGuard: true, pathLoop: true, count: pn } };
          }
        }
      }
      try {
        var result = await toolDef.handler(args);
        if (result && result.ok === false) return { content: [{ type: "text", text: result.error || "Tool failed" }], details: result };
        var text = typeof result === "string" ? result : typeof (result && result.result) === "string" ? result.result : JSON.stringify((result && result.result) || result || {}, null, 2);
        return { content: [{ type: "text", text: text }], details: result && result.result ? result.result : result };
      } catch (e) { return { content: [{ type: "text", text: e.message || "Tool error" }], details: null }; }
    }
  };
}
function buildModel(provider) {
  var modelId = provider.model || "qwen2.5-coder:1.5b";
  var baseUrl = provider.baseUrl || "http://browserai-ollama:11434/v1";
  var api = "openai-completions", providerType = "openai";
  var u = baseUrl.toLowerCase();
  if (u.includes("anthropic")) { api = "anthropic-messages"; providerType = "anthropic"; }
  else if (u.includes("google") || u.includes("gemini")) { api = "google-completions"; providerType = "google"; }
  return { id: modelId, name: modelId, api, provider: providerType, baseUrl, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

function mapContentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(c => c && (c.type === "text" || !c.type)).map(c => c.text || "").join("");
  return "";
}

function buildToolPrompt(piTools) {
  if (!piTools || piTools.length === 0) return "";
  var L = [];
  L.push("");
  L.push("=== TOOL USAGE PROTOCOL (STRICT) ===");
  L.push("You can perform real actions ONLY by emitting a tool call. You CANNOT create files or run code by writing prose.");
  L.push("");
  L.push("To call a tool, output a fenced json block containing EXACTLY one JSON object, on its own lines, with NO text before it:");
  L.push("");
  L.push("```json");
  L.push('{"tool": "TOOL_NAME", "arguments": { "param": "value" }}');
  L.push("```");
  L.push("");
  L.push("EXAMPLE — to create a file:");
  L.push("```json");
  L.push('{"tool": "write_file", "arguments": {"path": "index.html", "content": "<!DOCTYPE html>..."}}');
  L.push("```");
  L.push("");
  L.push("HARD RULES:");
  L.push("1. To DO anything (create/edit/list files, run commands) you MUST emit a tool call. Never just describe it.");
  L.push("2. Emit the json tool-call block FIRST, before any explanation. Do not add commentary above it.");
  L.push("3. Exactly ONE JSON object per ```json block. Use the key \"tool\" for the name and \"arguments\" for the params object.");
  L.push("4. write_file: put the ENTIRE file content in one call's \"content\". bash: full command string in \"command\".");
  L.push("5. After a tool result is returned, continue or finish. If a tool fails, try a DIFFERENT approach; never repeat the same failing call.");
  L.push("6. When the task is fully done, reply with a short confirmation and NO json block.");
  L.push("");
  L.push("AVAILABLE TOOLS:");
  piTools.slice(0, 30).forEach(function(t) {
    L.push("- " + t.name + ": " + (t.description || "no desc").substring(0, 100));
  });
  L.push("");
  return L.join("\n");
}

function parseToolCallsFromText(text) {
  if (!text) return { cleanText: text || "", toolCalls: [] };
  var toolCalls = [];
  var cleanText = text;

  function extractBalancedJson(str, startIdx) {
    if (str[startIdx] !== "{") return null;
    var depth = 0, inStr = false, esc = false;
    for (var i = startIdx; i < str.length; i++) {
      var ch = str[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"" && !esc) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return str.substring(startIdx, i + 1); }
    }
    return null;
  }

  // Accept several field-name conventions the model might use.
  function normalizeCall(p) {
    if (!p || typeof p !== "object") return null;
    var name, args;
    // OpenAI-style first: { function: { name, arguments } }
    if (p.function && typeof p.function === "object") {
      name = p.function.name;
      args = p.function.arguments;
    } else {
      name = p.tool || p.name || p.tool_name || (typeof p.function === "string" ? p.function : undefined);
      args = p.arguments || p.args || p.parameters || p.params || p.input;
    }
    if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { /* leave as-is */ } }
    if (name && (args === undefined || args === null)) args = {};
    if (name && typeof args === "object") return { name: String(name), args: args };
    return null;
  }

  function tryAddTool(jsonStr) {
    if (!jsonStr) return false;
    try {
      var p = JSON.parse(jsonStr);
      var nc = normalizeCall(p);
      if (nc) { toolCalls.push({ id: "tc_" + toolCalls.length + "_" + Date.now(), name: nc.name, args: nc.args }); return true; }
    } catch (e) {}
    return false;
  }

  // Strategy 1: any fenced code block (```json, ```, ```js, ```tool) containing a JSON object.
  var fenceRe = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
  var fm;
  while ((fm = fenceRe.exec(text)) !== null) {
    var block = (fm[1] || "").trim();
    var bs = block.indexOf("{");
    while (bs >= 0) {
      var js = extractBalancedJson(block, bs);
      if (js && tryAddTool(js)) break;
      bs = block.indexOf("{", bs + 1);
    }
  }

  // Strategy 2: bare JSON objects with "tool"/"name"/"function" anywhere (model forgot fences).
  if (toolCalls.length === 0) {
    var keyRe = /"(tool|name|tool_name|function)"\s*:/g;
    var km;
    while ((km = keyRe.exec(text)) !== null) {
      var braceStart = text.lastIndexOf("{", km.index);
      if (braceStart < 0) continue;
      var js2 = extractBalancedJson(text, braceStart);
      if (js2 && tryAddTool(js2)) break;
    }
  }

  if (toolCalls.length > 0) {
    // Strip any fenced blocks from the visible text.
    cleanText = cleanText.replace(/```[a-zA-Z0-9_-]*[\s\S]*?```/g, "").trim();
  }
  return { cleanText: cleanText, toolCalls: toolCalls };
}

export async function runAgentWithPiCore({
  providerInput = {}, history = [], extraSystem = "", res, userId = "", workspaceScope = "", maxSteps = 0,
}) {
  var wrappedRes = {
    write: function(chunk) { try { res.write(chunk); } catch {} },
    end: function() { try { wrappedRes.writableEnded = true; res.end(); } catch {} },
    destroyed: false, writableEnded: false,
  };
  if (typeof res.on === "function") {
    res.on("close", function() { wrappedRes.destroyed = true; });
    res.on("error", function() { wrappedRes.destroyed = true; });
  }

  sse(wrappedRes, "stream_protocol", { version: 1, events: ["stream_protocol","agent_context","agent_task","agent_state","thinking","thinking_delta","assistant_delta","assistant","thought","tool_preview","tool_router","tool_start","tool_progress","tool_result","file_change","tool_diagnostic","ask_user","usage","done","error"] });

  var provider;
  try {
    provider = (providerInput && providerInput.apiKey && providerInput.baseUrl) ? providerInput : resolveProviderFromInput(providerInput || {}, { requireBearer: false });
    console.log("[Pi Core Engine] Starting userId=" + userId + " chatId=" + workspaceScope + " model=" + (provider && provider.model));
  } catch (e) {
    sse(wrappedRes, "error", { message: "Provider error: " + e.message });
    sseDone(wrappedRes, { reason: "no-provider" });
    return;
  }

  // ── Reliable model/provider defaults (fix: empty answers when model omitted) ──
  // Priority when the request didn't specify a provider: use a WORKING GLM flash
  // model from the unified catalog (z.ai + bigmodel). Only if none is available
  // do we fall back to the local Ollama model. This keeps default answers fast
  // and high-quality instead of relying on the weak 1.5B local model.
  if (!provider.baseUrl && !provider.apiKey && !provider.model) {
    try {
      var cat = await getAvailableModels({});
      var best = (cat && cat.models || [])[0];
      if (best) {
        var pc = resolveModelProvider(best.id);
        if (pc && pc.apiKey) { provider.baseUrl = pc.baseUrl; provider.apiKey = pc.apiKey; provider.model = pc.model; }
      }
    } catch (e) { /* fall through to Ollama default */ }
  }
  if (!provider.baseUrl) provider.baseUrl = "http://browserai-ollama:11434/v1";
  if (!provider.apiKey) provider.apiKey = "ollama";
  if (!provider.model) {
    var u0 = String(provider.baseUrl || "").toLowerCase();
    if (u0.includes("ollama") || u0.includes("11434")) provider.model = "qwen2.5-coder:1.5b";
  }

  // ── Workspace scoping: run the ENTIRE agent execution inside the chat scope so
  // file tools resolve to /workspace/chats/<chatId> instead of the shared root.
  // AsyncLocalStorage propagates through awaits, so wrapping prompt() is enough.
  return await withWorkspaceScope(workspaceScope || "", async function() {

  var cwd = getContainerWorkspaceRoot() || "/workspace";
  var systemPrompt = extraSystem || "BrowserAI agent. Workspace: " + cwd + ". OS: Linux. Respond in Russian.";

  var loopGuard = new Map();
  var piTools = Object.entries(TOOLS).filter(function(entry) { return typeof entry[1].handler === "function"; }).map(function(entry) { return wrapTool(entry[0], entry[1], loopGuard); });
  var model = buildModel(provider);
  var maxStepsVal = Math.max(1, Number(maxSteps) || 50);
  var isDS = isDeepSeekWebUrl(provider.baseUrl);

  var step = 0;
  var lastAssistantText = "";
  var totals = { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: 0 };

  var piMessages = (history || []).slice(0, -1).map(function(m) { return { role: m.role || "user", content: typeof m.content === "string" ? m.content : "" }; });

  var customStreamFn = function(model, context, options) {
    var stream = createAssistantMessageEventStream();
    (async function() {
      var partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, totalTokens: 0 } };
      try {
        stream.push({ type: "start", partial: partial });
        var currentTextIndex = -1, currentThinkingIndex = -1, accumulatedText = "";

        await callLLMStream({
          baseUrl: provider.baseUrl, apiKey: provider.apiKey,
          authType: provider.authType || "bearer", authHeader: provider.authHeader || "",
          extraHeaders: provider.extraHeaders || {}, model: provider.model,
          messages: context.messages.map(function(m) { return { role: m.role, content: mapContentToString(m.content) }; }),
          temperature: provider.temperature != null ? provider.temperature : 0.3,
          onTextDelta: function(chunk, meta) {
            if (meta && meta.kind === "thinking") {
              if (currentThinkingIndex === -1) {
                currentThinkingIndex = partial.content.length;
                partial.content.push({ type: "thinking", thinking: "" });
                stream.push({ type: "thinking_start", contentIndex: currentThinkingIndex });
              }
              partial.content[currentThinkingIndex].thinking += chunk;
              stream.push({ type: "thinking_delta", contentIndex: currentThinkingIndex, delta: chunk });
            } else {
              accumulatedText += chunk;
              // For DeepSeek-web we DON'T stream raw text deltas: the model mixes
              // ```json tool blocks into the prose, which would (a) show stray ```
              // fences in the UI and (b) make tools appear before the cleaned text.
              // Instead we buffer here and emit the CLEANED text after parsing,
              // followed by the tool calls — giving correct "text → tools" order.
              if (isDS) return;
              if (currentTextIndex === -1) {
                currentTextIndex = partial.content.length;
                partial.content.push({ type: "text", text: "" });
                stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: partial });
              }
              partial.content[currentTextIndex].text += chunk;
              stream.push({ type: "text_delta", contentIndex: currentTextIndex, delta: chunk });
            }
          },
          onUsage: function(u) { if (u) partial.usage = { input: u.prompt || 0, output: u.completion || 0, totalTokens: u.total || 0 }; },
        });

        if (isDS) {
          var parsed = parseToolCallsFromText(accumulatedText);
          // Always emit cleaned text (fences stripped) as the visible answer,
          // BEFORE any tool calls, so the UI order is "reasoning → tools".
          var cleanText = String(parsed.cleanText || accumulatedText || "")
            // Remove any leftover code fences / stray backticks the model emitted.
            .replace(/```[a-zA-Z0-9_-]*[\s\S]*?```/g, "")
            .replace(/`{1,}/g, "")
            .trim();
          if (cleanText) {
            currentTextIndex = partial.content.length;
            partial.content.push({ type: "text", text: cleanText });
            stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: partial });
            stream.push({ type: "text_delta", contentIndex: currentTextIndex, delta: cleanText });
          }
          if (piTools.length > 0 && parsed.toolCalls.length > 0) {
            // Dedupe identical tool calls within a single response (DeepSeek
            // often repeats the same block, e.g. create_folder x3).
            var seenSig = {};
            for (var ti = 0; ti < parsed.toolCalls.length; ti++) {
              var tc = parsed.toolCalls[ti];
              var matched = piTools.find(function(t) { return t.name === tc.name; });
              if (!matched) {
                matched = piTools.find(function(t) { return t.name.indexOf(tc.name) >= 0 || tc.name.indexOf(t.name) >= 0; });
                if (matched) console.log("[Pi Core Engine] Fuzzy match: " + tc.name + " -> " + matched.name);
              }
              if (!matched) continue;
              tc.name = matched.name;
              var sig;
              try { sig = tc.name + ":" + JSON.stringify(tc.args || {}); } catch (e) { sig = tc.name + ":?"; }
              if (seenSig[sig]) { console.log("[Pi Core Engine] Skipped duplicate tool call: " + sig); continue; }
              seenSig[sig] = true;
              partial.content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
              stream.push({ type: "tool_use_start", toolCallId: tc.id, toolName: tc.name, args: tc.args });
            }
          }
        }

        if (currentThinkingIndex !== -1) stream.push({ type: "thinking_end", contentIndex: currentThinkingIndex });
        if (currentTextIndex !== -1) stream.push({ type: "text_end", contentIndex: currentTextIndex });
        stream.push({ type: "done", reason: "stop", message: partial, usage: partial.usage });
        stream.end();
      } catch (e) {
        partial.stopReason = "error"; partial.errorMessage = e.message;
        stream.push({ type: "error", reason: "error", error: partial, errorMessage: e.message, usage: partial.usage });
        stream.end();
      }
    })();
    return stream;
  };

  // ── Hybrid engine selection ──
  // Cloud providers (OpenAI/Anthropic/Google) → native pi-ai stream() with real
  // structured tool-calling. Web sessions (DeepSeek/z.ai) and Ollama → legacy
  // customStreamFn (text-JSON tool parsing). UI protocol is identical either way.
  var useNative = false;
  try { useNative = isNativeCapableProvider(provider); } catch (e) { useNative = false; }

  var agentTools = piTools;
  var agentModel = model;
  var agentStreamFn = customStreamFn;
  var engineName = "pi-agent-core";
  if (useNative) {
    try {
      agentTools = toTypeboxTools(piTools);
      agentModel = buildNativeModel(provider);
      agentStreamFn = buildNativeStreamFn(provider);
      engineName = "pi-ai-native";
      console.log("[Pi Native Engine] Using native pi-ai tool-calling for " + provider.baseUrl);
    } catch (e) {
      console.log("[Pi Native Engine] native setup failed, falling back to legacy: " + e.message);
      agentTools = piTools; agentModel = model; agentStreamFn = customStreamFn; engineName = "pi-agent-core";
    }
  }

  var agent = new Agent({
    initialState: { systemPrompt: systemPrompt, model: agentModel, tools: agentTools, messages: piMessages },
    streamFn: agentStreamFn,
    getApiKey: async function() { return provider.apiKey || "ollama"; },
  });

  sse(wrappedRes, "agent_context", { model: provider.model, provider: provider.baseUrl, maxSteps: maxStepsVal, serverRoute: "/api/agent/chat-pi", engine: engineName, toolCount: agentTools.length });

  try {
    var lastUserMsg = (history || []).slice().reverse().find(function(m) { return m.role === "user"; });
    var promptText = lastUserMsg ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : "") : "hi";
    if (isDS && piTools.length > 0) promptText = buildToolPrompt(piTools) + "\n\nUser request: " + promptText;

    agent.subscribe(function(event, signal) {
      if (wrappedRes.destroyed || (signal && signal.aborted)) return;
      switch (event.type) {
        case "turn_start":
          step++; totals.llmCalls = step;
          sse(wrappedRes, "thinking", { step: step });
          sse(wrappedRes, "agent_state", { phase: "execute", step: step, maxSteps: maxStepsVal, engine: "pi-agent-core" });
          break;
        case "message_update":
          var e = event.assistantMessageEvent;
          if (e && e.type === "text_delta" && typeof e.delta === "string" && e.delta) sse(wrappedRes, "assistant_delta", { step: step, chunk: e.delta });
          if (e && e.type === "thinking_delta" && typeof e.delta === "string" && e.delta) sse(wrappedRes, "thinking_delta", { step: step, chunk: e.delta });
          break;
        case "tool_execution_start":
          sse(wrappedRes, "tool_preview", { step: step, name: event.toolName, args: event.args });
          sse(wrappedRes, "tool_start", { step: step, name: event.toolName, args: event.args });
          break;
        case "tool_execution_update":
          sse(wrappedRes, "tool_progress", { step: step, name: event.toolName, partial: event.partialResult });
          break;
        case "tool_execution_end":
          sse(wrappedRes, "tool_result", { step: step, name: event.toolName, ok: !event.isError, result: event.isError ? null : event.result, error: event.isError ? (typeof event.result === "string" ? event.result : "Unknown error") : null });
          break;
        case "turn_end":
          var m = event.message;
          if (m && Array.isArray(m.content)) {
            var t = m.content.filter(function(c) { return c && c.type === "text"; }).map(function(c) { return c.text || ""; }).join("");
            if (t && t !== lastAssistantText) { lastAssistantText = t; sse(wrappedRes, "assistant", { step: step, text: t }); }
          }
          sse(wrappedRes, "usage", { step: step, prompt: totals.prompt, completion: totals.completion, total: totals.total, reasoningTokens: totals.reasoningTokens, llmCalls: totals.llmCalls, totals: { prompt: totals.prompt, completion: totals.completion, total: totals.total, reasoningTokens: totals.reasoningTokens, llmCalls: totals.llmCalls } });
          break;
        default: break;
      }
    });

    await agent.prompt(promptText);

    var finalMsg = agent.state.messages[agent.state.messages.length - 1];
    if (finalMsg && finalMsg.role === "assistant" && Array.isArray(finalMsg.content)) {
      var ft = finalMsg.content.filter(function(c) { return c && c.type === "text"; }).map(function(c) { return c.text || ""; }).join("");
      if (ft && ft !== lastAssistantText && !wrappedRes.destroyed) { lastAssistantText = ft; sse(wrappedRes, "assistant", { step: step, text: ft }); }
    }
    sseDone(wrappedRes, { steps: step, reason: "complete" }, { prompt: totals.prompt, completion: totals.completion, total: totals.total, reasoningTokens: totals.reasoningTokens, llmCalls: step });
    wrappedRes.end();
  } catch (e) {
    if (!wrappedRes.destroyed && !res.headersSent) {
      sse(wrappedRes, "error", { message: e.message || "Agent engine error" });
      sseDone(wrappedRes, { steps: step, reason: "engine-error" }, totals);
      wrappedRes.end();
    }
  }

  }); // end withWorkspaceScope
}

export default runAgentWithPiCore;
