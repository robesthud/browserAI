/**
 * openhandsBridge.js — Совершенный прокси-мост к OpenHands Agent Server (FastAPI)
 *
 * Осуществляет 100% глубокую интеграцию OpenHands в минималистичный React UI BrowserAI.
 * Выполняет автоматическую инициализацию настроек (POST /api/settings) перед стартом сессии.
 */

const OPENHANDS_SERVER = process.env.OPENHANDS_AGENT_SERVER || "http://openhands:18000";

function sse(res, event, data) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

export async function initOpenHandsSettings({ model, provider }) {
  const url = `${OPENHANDS_SERVER}/api/settings`;
  let baseModel = provider?.model || model || process.env.OPENHANDS_LLM_MODEL || "glm-4.5-flash";
  const apiKey = provider?.apiKey || process.env.BIGMODEL_API_KEY || process.env.ZAI_API_KEY || "dba035e8741f4f68afdd0f58951e0ee0.zOIQpvWagZlY5r7e";
  const baseUrl = provider?.baseUrl || process.env.OPENHANDS_LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";

  // Для корректной работы LiteLLM со сторонними OpenAI-совместимыми провайдерами
  if ((baseUrl.includes("bigmodel.cn") || baseUrl.includes("api.z.ai")) && !baseModel.startsWith("openai/")) {
    baseModel = `openai/${baseModel}`;
  }

  const body = {
    agent: "CodeActAgent",
    llm_model: baseModel,
    llm_api_key: apiKey,
    llm_base_url: baseUrl,
    max_iterations: 50,
    confirmation_mode: false,
    enable_default_condenser: true,
    enable_solvability_analysis: true
  };

  console.log(`[OpenHands Bridge] Pushing settings to ${url}, model=${baseModel}`);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    console.warn(`[OpenHands Bridge] Settings push returned ${r.status}: ${raw}`);
  }
  return r.ok;
}

export async function createConversation({ prompt, model, workspaceScope, provider }) {
  // 1. Сначала гарантированно инициализируем настройки в OpenHands
  await initOpenHandsSettings({ model, provider });

  // 2. Создаем сессию согласно спецификации InitSessionRequest
  const url = `${OPENHANDS_SERVER}/api/conversations`;
  const body = {
    initial_user_msg: prompt || "hi",
    conversation_instructions: `You are BrowserAI CodeAct Agent. Use your tools and bash terminal to solve tasks.`
  };

  const headers = { "Content-Type": "application/json" };
  const apiKey = provider?.apiKey || process.env.BIGMODEL_API_KEY || process.env.ZAI_API_KEY || "";
  if (apiKey && apiKey !== "__managed__") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    throw new Error(`OpenHands conversation init failed (${r.status}): ${raw}`);
  }
  return await r.json();
}

export async function runAgentConversation(id) {
  const url = `${OPENHANDS_SERVER}/api/conversations/${id}/start`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    throw new Error(`OpenHands start failed (${r.status}): ${raw}`);
  }
  return await r.json();
}

export async function interruptConversation(id) {
  const url = `${OPENHANDS_SERVER}/api/conversations/${id}/stop`;
  const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10000) });
  return r.ok;
}

export async function streamAgentEvents({ conversationId, res, model }) {
  let WSConstructor = globalThis.WebSocket;
  if (!WSConstructor) {
    try {
      const wsModule = await import("ws");
      WSConstructor = wsModule.default || wsModule.WebSocket;
    } catch {
      throw new Error("No WebSocket constructor available in runtime");
    }
  }

  const wsUrl = OPENHANDS_SERVER.replace(/^http/, "ws") + `/api/sockets/events/${conversationId}`;
  console.log(`[OpenHands Bridge] Connecting WS to ${wsUrl}`);
  const ws = new WSConstructor(wsUrl);

  let step = 0;
  let hasEnded = false;
  let fullAnswer = "";
  let activeTool = null;

  ws.onopen = () => {
    console.log(`[OpenHands Bridge] WS connected for conversation ${conversationId}`);
    sse(res, "stream_protocol", { version: 1, events: ["stream_protocol","agent_context","agent_task","agent_state","thinking","thinking_delta","assistant_delta","assistant","thought","tool_preview","tool_start","tool_progress","tool_result","done","error"] });
    sse(res, "agent_context", { model: model || "glm-4.5-flash", provider: OPENHANDS_SERVER, maxSteps: 50, serverRoute: "/api/agent/chat", engine: "openhands" });
    sse(res, "thinking", { step: ++step });
    sse(res, "agent_state", { phase: "plan", step, maxSteps: 50, engine: "openhands" });
  };

  ws.onmessage = (event) => {
    if (hasEnded || res.destroyed) return;
    try {
      const msg = JSON.parse(event.data);
      const action = msg.action || {};
      const observation = msg.observation || {};
      const type = msg.type || action.type || observation.type || msg.event_type || "";

      if (type === "AgentThinkAction" || type === "think" || type === "thinking") {
        const text = action.thought || action.content || msg.content || "";
        if (text) {
          sse(res, "thinking_delta", { step, chunk: text });
          sse(res, "thought", { step, text });
        }
      } else if (type === "CmdRunAction" || type === "run_command" || type === "cmd") {
        const cmd = action.command || action.cmd || action.content || "bash";
        activeTool = "bash";
        sse(res, "tool_start", { step: ++step, name: "bash", args: { command: cmd } });
      } else if (type === "CmdOutputObservation" || type === "cmd_output") {
        const output = observation.content || observation.output || msg.content || "";
        sse(res, "tool_progress", { step, name: "bash", partial: output });
        sse(res, "tool_result", { step, name: "bash", ok: observation.exit_code === 0 || !observation.exit_code, result: output, error: observation.exit_code > 0 ? output : null });
        activeTool = null;
      } else if (type === "FileWriteAction" || type === "write_file") {
        const path = action.path || action.file || "file";
        activeTool = "write_file";
        sse(res, "tool_start", { step: ++step, name: "write_file", args: { path, content: action.content || "" } });
      } else if (type === "FileWriteObservation") {
        sse(res, "tool_result", { step, name: "write_file", ok: true, result: { path: observation.path || "file", success: true } });
        activeTool = null;
      } else if (type === "FileReadAction" || type === "read_file") {
        const path = action.path || action.file || "file";
        activeTool = "read_file";
        sse(res, "tool_start", { step: ++step, name: "read_file", args: { path } });
      } else if (type === "FileReadObservation") {
        sse(res, "tool_result", { step, name: "read_file", ok: true, result: { path: observation.path || "file", content: observation.content || "" } });
        activeTool = null;
      } else if (type === "IPythonRunCellAction" || type === "python") {
        activeTool = "python";
        sse(res, "tool_start", { step: ++step, name: "python", args: { code: action.code || action.content || "" } });
      } else if (type === "IPythonRunCellObservation") {
        const output = observation.content || observation.output || "";
        sse(res, "tool_progress", { step, name: "python", partial: output });
        sse(res, "tool_result", { step, name: "python", ok: !observation.error, result: output, error: observation.error ? output : null });
        activeTool = null;
      } else if (type === "AgentFinishAction" || type === "assistant" || type === "final_response") {
        const chunk = action.response || action.content || msg.content || "";
        if (chunk) {
          fullAnswer += chunk;
          sse(res, "assistant_delta", { step, chunk });
        }
      } else if (type === "status" && msg.status === "completed") {
        hasEnded = true;
        if (fullAnswer) sse(res, "assistant", { step, text: fullAnswer });
        sse(res, "done", { reason: "complete", steps: step });
        res.end();
        ws.close();
      } else if (type === "error" || (type === "status" && msg.status === "error")) {
        hasEnded = true;
        sse(res, "error", { message: msg.message || msg.content || msg.error || "OpenHands runtime error" });
        sse(res, "done", { reason: "engine-error", steps: step });
        res.end();
        ws.close();
      }
    } catch (e) {
      console.error("[OpenHands Bridge] WS message parse error:", e);
    }
  };

  ws.onerror = (e) => {
    console.error("[OpenHands Bridge] WS error:", e);
    if (!hasEnded && !res.destroyed) {
      hasEnded = true;
      sse(res, "error", { message: "OpenHands WS connection error" });
      sse(res, "done", { reason: "engine-error", steps: step });
      res.end();
    }
  };

  ws.onclose = () => {
    console.log(`[OpenHands Bridge] WS closed for conversation ${conversationId}`);
    if (!hasEnded && !res.destroyed) {
      hasEnded = true;
      if (fullAnswer) sse(res, "assistant", { step, text: fullAnswer });
      sse(res, "done", { reason: "complete", steps: step });
      res.end();
    }
  };

  if (typeof res.on === "function") {
    res.on("close", () => { hasEnded = true; try { ws.close(); } catch {} });
  }
}

export async function proxyAgentChat({ req, res }) {
  try {
    const history = req.body?.history || [];
    const lastUserMsg = history.slice().reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg ? lastUserMsg.content : req.body?.prompt || "hi";
    const model = req.body?.model || req.body?.providerInput?.model || "glm-4.5-flash";
    const workspaceScope = req.body?.chatId || "";

    let provider = req.body?.providerInput || req.body?.provider || {};
    try {
      const { resolveProviderFromInput } = await import("./providerResolution.js");
      provider = resolveProviderFromInput(req.body || {}, { requireBearer: false });
    } catch { /* fallback to req.body values */ }

    console.log(`[OpenHands Bridge] Initializing conversation for chatId=${workspaceScope}, model=${model}`);
    const conv = await createConversation({ prompt, model, workspaceScope, provider });
    const convId = conv.id || conv.conversation_id || workspaceScope || Date.now().toString();

    console.log(`[OpenHands Bridge] Starting run for conversation ${convId}`);
    await runAgentConversation(convId);

    console.log(`[OpenHands Bridge] Streaming events for conversation ${convId}`);
    await streamAgentEvents({ conversationId: convId, res, model });
  } catch (e) {
    console.error("[OpenHands Bridge] Proxy fatal error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      sse(res, "error", { message: e.message });
      sse(res, "done", { reason: "crash", steps: 0 });
      res.end();
    }
  }
}

export default { initOpenHandsSettings, createConversation, runAgentConversation, interruptConversation, streamAgentEvents, proxyAgentChat };
