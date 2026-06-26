/**
 * agentEngine.js v5 — BrowserAI pi-agent-core adapter (stability-enhanced)
 *
 * DeepSeek tool integration: prompt injection + JSON parsing + fuzzy matching.
 * Dual-strategy parser: ```json blocks AND bare JSON objects.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TOOLS } from "./agentTools.js";
import { resolveProviderFromInput } from "./providerResolution.js";
import { withWorkspaceScope, getContainerWorkspaceRoot } from "./workspace.js";
import { callLLMStream } from "./llmClient.js";
import { isDeepSeekWebUrl } from "./deepseekWeb.js";

function sse(target, event, data) {
  if (!target || target.destroyed || target.writableEnded) return;
  try { target.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch {}
}
function sseDone(target, meta, tokens) {
  sse(target, "done", { reason: meta?.reason || "complete", ...meta, tokens: tokens || { prompt: 0, completion: 0, total: 0, reasoningTokens: 0, llmCalls: meta?.steps || 0 } });
}
function wrapTool(name, toolDef) {
  var params = toolDef.parameters || toolDef.params || {};
  return {
    name, label: toolDef.label || name, description: toolDef.description || "", parameters: params,
    execute: async function(toolCallId, args, signal, onUpdate) {
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
  L.push("=== TOOL USAGE PROTOCOL ===");
  L.push("To call a tool, output EXACTLY this JSON format on its own line:");
  L.push("");
  L.push("```json");
  L.push("{" + JSON.stringify("tool") + ": " + JSON.stringify("TOOL_NAME") + ", " + JSON.stringify("arguments") + ": {" + JSON.stringify("param") + ": " + JSON.stringify("value") + "}}");
  L.push("```");
  L.push("");
  L.push("RULES:");
  L.push("1. When asked to DO something -> call a tool IMMEDIATELY. Never describe.");
  L.push("2. Output tool call FIRST. Explain AFTER seeing the result.");
  L.push("3. If tool fails -> try DIFFERENT approach. Do NOT repeat same failing call.");
  L.push("4. write_file: ALL content in ONE call. bash: full command string.");
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
      var c = str[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === "\"" && !esc) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return str.substring(startIdx, i + 1); }
    }
    return null;
  }

  function tryAddTool(jsonStr) {
    if (!jsonStr) return false;
    try { var p = JSON.parse(jsonStr); if (p.tool && p.arguments) { toolCalls.push({ id: "tc_" + toolCalls.length + "_" + Date.now(), name: p.tool, args: p.arguments }); return true; } } catch(e) {}
    return false;
  }

  // Strategy 1: ```json ... ``` blocks
  var idx = 0;
  while (idx < text.length) {
    var start = text.indexOf("```json", idx);
    if (start === -1) break;
    var jsonStart = start + 7;
    if (text[jsonStart] === "\n") jsonStart++;
    var end = text.indexOf("```", jsonStart);
    if (end === -1) { idx = start + 7; continue; }
    var block = text.substring(jsonStart, end).trim();
    var braceStart = block.indexOf("{");
    if (braceStart >= 0) {
      var jsonStr = extractBalancedJson(block, braceStart);
      tryAddTool(jsonStr);
    }
    idx = end + 3;
  }

  // Strategy 2: bare {"tool":... anywhere in text (model forgot code fences)
  if (toolCalls.length === 0) {
    idx = 0;
    while (idx < text.length) {
      var toolIdx = text.indexOf(tool, idx);
      if (toolIdx === -1) break;
      var braceStart = text.lastIndexOf("{", toolIdx);
      if (braceStart >= 0 && (toolIdx - braceStart) < 300) {
        var jsonStr2 = extractBalancedJson(text, braceStart);
        if (jsonStr2 && jsonStr2.indexOf(tool) > 0 && jsonStr2.indexOf(arguments) > 0) {
          tryAddTool(jsonStr2);
          if (toolCalls.length > 0) break;
        }
      }
      idx = toolIdx + 6;
    }
  }

  if (toolCalls.length > 0) {
    cleanText = cleanText.replace(/```json[\s\S]*?```/g, "").trim();
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

  var cwd = getContainerWorkspaceRoot() || "/workspace";
  var systemPrompt = extraSystem || "BrowserAI agent. Workspace: " + cwd + ". OS: Linux. Respond in Russian.";

  var piTools = Object.entries(TOOLS).filter(function(entry) { return typeof entry[1].handler === "function"; }).map(function(entry) { return wrapTool(entry[0], entry[1]); });
  var model = buildModel(provider);
  var maxStepsVal = Math.max(1, Number(maxSteps) || 50);
  var isDS = isDeepSeekWebUrl(provider.baseUrl);

  var step = 0;
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

        if (isDS && piTools.length > 0) {
          var parsed = parseToolCallsFromText(accumulatedText);
          if (parsed.toolCalls.length > 0) {
            if (currentTextIndex !== -1) partial.content[currentTextIndex].text = parsed.cleanText;
            for (var ti = 0; ti < parsed.toolCalls.length; ti++) {
              var tc = parsed.toolCalls[ti];
              var matched = piTools.find(function(t) { return t.name === tc.name; });
              if (!matched) {
                matched = piTools.find(function(t) { return t.name.indexOf(tc.name) >= 0 || tc.name.indexOf(t.name) >= 0; });
                if (matched) console.log("[Pi Core Engine] Fuzzy match: " + tc.name + " -> " + matched.name);
              }
              if (matched) {
                tc.name = matched.name;
                partial.content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
                stream.push({ type: "tool_use_start", toolCallId: tc.id, toolName: tc.name, args: tc.args });
              }
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

  var agent = new Agent({
    initialState: { systemPrompt: systemPrompt, model: model, tools: piTools, messages: piMessages },
    streamFn: customStreamFn,
    getApiKey: async function() { return provider.apiKey || "ollama"; },
  });

  sse(wrappedRes, "agent_context", { model: provider.model, provider: provider.baseUrl, maxSteps: maxStepsVal, serverRoute: "/api/agent/chat-pi", engine: "pi-agent-core", toolCount: piTools.length });

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
            if (t) sse(wrappedRes, "assistant", { step: step, text: t });
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
      if (ft && !wrappedRes.destroyed) sse(wrappedRes, "assistant", { step: step, text: ft });
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
}

export default runAgentWithPiCore;
