/**
 * openhandsBridge.js — Прокси-мост к OpenHands Agent Server (FastAPI)
 *
 * Перехватывает запросы от BrowserAI React UI и транслирует их в REST/WS API OpenHands.
 * Порт Agent Server: 18000
 */

const OPENHANDS_SERVER = process.env.OPENHANDS_AGENT_SERVER || "http://openhands:18000";

function sse(res, event, data) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

export async function createConversation({ prompt, model, workspaceScope }) {
  const url = `${OPENHANDS_SERVER}/api/conversations`;
  const body = {
    agent: "CodeActAgent",
    llm_config: {
      model: model || process.env.OPENHANDS_LLM_MODEL || "glm-4.5-flash",
      api_key: process.env.BIGMODEL_API_KEY || process.env.ZAI_API_KEY || "dba035e8741f4f68afdd0f58951e0ee0.zOIQpvWagZlY5r7e",
      base_url: process.env.OPENHANDS_LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4"
    },
    workspace_mount_path: workspaceScope ? `/opt/browserai-data/workspace/chats/${workspaceScope}` : "/opt/browserai-data/workspace",
    initial_prompt: prompt || "hi"
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const url = `${OPENHANDS_SERVER}/api/conversations/${id}/run`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    throw new Error(`OpenHands run failed (${r.status}): ${raw}`);
  }
  return await r.json();
}

export async function interruptConversation(id) {
  const url = `${OPENHANDS_SERVER}/api/conversations/${id}/interrupt`;
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
      const action = msg.action || msg.event || {};
      const type = msg.type || action.type || msg.event_type || "";

      if (type === "thinking" || type === "think") {
        sse(res, "thinking_delta", { step, chunk: msg.content || action.content || "" });
      } else if (type === "thought" || type === "planning") {
        sse(res, "thought", { step, text: msg.content || action.content || "План действий обновлен" });
      } else if (type === "run_command" || type === "cmd" || type === "bash") {
        const cmd = action.command || action.cmd || action.content || "bash";
        sse(res, "tool_start", { step: ++step, name: "bash", args: { command: cmd } });
      } else if (type === "run_command_output" || type === "cmd_output") {
        sse(res, "tool_progress", { step, name: "bash", partial: msg.content || msg.output || "" });
        sse(res, "tool_result", { step, name: "bash", ok: true, result: msg.content || msg.output || "" });
      } else if (type === "file_op" || type === "write_file" || type === "edit") {
        const path = action.path || action.file || "file";
        sse(res, "tool_start", { step: ++step, name: type, args: { path, content: action.content || "" } });
        sse(res, "tool_result", { step, name: type, ok: true, result: { path, success: true } });
      } else if (type === "assistant" || type === "message" || type === "final_response") {
        const chunk = msg.content || action.content || "";
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

    console.log(`[OpenHands Bridge] Initializing conversation for chatId=${workspaceScope}, model=${model}`);
    const conv = await createConversation({ prompt, model, workspaceScope });
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

export default { createConversation, runAgentConversation, interruptConversation, streamAgentEvents, proxyAgentChat };
