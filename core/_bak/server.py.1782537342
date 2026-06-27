import os
import json
import time
import asyncio
import httpx
import websockets
from fastapi import FastAPI, Request, HTTPException, status
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from core.database import list_keys, upsert_key, delete_key, set_active_key, get_active_key

app = FastAPI(title="BrowserAI-OpenHands Core Monolith")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENHANDS_SERVER = os.environ.get("OPENHANDS_AGENT_SERVER", "http://openhands:18000")

# ── API Роуты Настроек и Ключей (Изоляция от BrowserAI UI) ──

@app.get("/api/settings")
@app.get("/api/keys")
async def get_settings():
    keys = list_keys()
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {
        "keys": keys,
        "activeKeyId": active["id"] if active else None,
        "params": {"systemPrompt": "Ты — точный и прямой ассистент.", "temperature": 0.7, "stream": True, "useWebAI": False},
        "vault": {"enabled": False, "locked": False}
    }

@app.post("/api/keys")
async def post_key(request: Request):
    data = await request.json()
    if not data.get("id"):
        raise HTTPException(status_code=400, detail="id required")
    keys = upsert_key(data)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None}

@app.post("/api/keys/{key_id}/activate")
async def activate_key(key_id: str):
    keys = set_active_key(key_id)
    return {"keys": keys, "activeKeyId": key_id}

@app.delete("/api/keys/{key_id}")
async def remove_key(key_id: str):
    keys = delete_key(key_id)
    active = next((k for k in keys if k.get("isActive")), keys[0] if keys else None)
    return {"keys": keys, "activeKeyId": active["id"] if active else None}

@app.get("/api/health")
async def get_health():
    return {"deepseekManaged": True, "sandbox": True, "browser": True, "openhands": True, "monolith": True}

# ── Совершенный Прокси-Мост к OpenHands Agent Server ──

async def init_openhands_settings(client: httpx.AsyncClient, model: str, provider: dict):
    url = f"{OPENHANDS_SERVER}/api/settings"
    base_model = provider.get("model") or model or "glm-4.5-flash"
    api_key = provider.get("apiKey") or os.environ.get("BIGMODEL_API_KEY", "")
    base_url = provider.get("baseUrl") or os.environ.get("OPENHANDS_LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")

    if ("bigmodel.cn" in base_url or "api.z.ai" in base_url) and not base_model.startswith("openai/"):
        base_model = f"openai/{base_model}"

    payload = {
        "agent": "CodeActAgent",
        "llm_model": base_model,
        "llm_api_key": api_key,
        "llm_base_url": base_url,
        "max_iterations": 50,
        "confirmation_mode": False,
        "enable_default_condenser": True,
        "enable_solvability_analysis": True
    }
    try:
        r = await client.post(url, json=payload, timeout=10.0)
        print(f"[OpenHands Bridge] Settings push: {r.status_code}")
    except Exception as e:
        print(f"[OpenHands Bridge] Settings push error: {e}")

async def create_conversation(client: httpx.AsyncClient, prompt: str, model: str, workspace_scope: str, provider: dict):
    await init_openhands_settings(client, model, provider)
    url = f"{OPENHANDS_SERVER}/api/conversations"
    
    # 100% точное соответствие InitSessionRequest OpenAPI схеме OpenHands:
    payload = {
        "initial_user_msg": prompt or "hi",
        "conversation_instructions": "You are BrowserAI CodeAct Agent. Use your tools and bash terminal to solve tasks."
    }
    headers = {"Content-Type": "application/json"}
    api_key = provider.get("apiKey") or os.environ.get("BIGMODEL_API_KEY", "")
    if api_key and api_key != "__managed__":
        headers["Authorization"] = f"Bearer {api_key}"

    r = await client.post(url, json=payload, headers=headers, timeout=15.0)
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=f"OpenHands init failed: {r.text}")
    return r.json()

async def start_conversation(client: httpx.AsyncClient, conv_id: str):
    url = f"{OPENHANDS_SERVER}/api/conversations/{conv_id}/start"
    r = await client.post(url, json={}, timeout=15.0)
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=f"OpenHands start failed: {r.text}")
    return r.json()

async def event_stream_generator(conv_id: str, model: str):
    ws_url = OPENHANDS_SERVER.replace("http", "ws") + f"/api/sockets/events/{conv_id}"
    step = 0
    full_answer = ""

    def sse_chunk(event: str, data: dict):
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    yield sse_chunk("stream_protocol", {"version": 1, "events": ["stream_protocol","agent_context","agent_task","agent_state","thinking","thinking_delta","assistant_delta","assistant","thought","tool_preview","tool_start","tool_progress","tool_result","done","error"]})
    yield sse_chunk("agent_context", {"model": model or "glm-4.5-flash", "provider": OPENHANDS_SERVER, "maxSteps": 50, "serverRoute": "/api/agent/chat", "engine": "openhands"})
    
    step += 1
    yield sse_chunk("thinking", {"step": step})
    yield sse_chunk("agent_state", {"phase": "plan", "step": step, "maxSteps": 50, "engine": "openhands"})

    try:
        async with websockets.connect(ws_url) as ws:
            async for message in ws:
                msg = json.loads(message)
                action = msg.get("action", {})
                observation = msg.get("observation", {})
                evt_type = msg.get("type") or action.get("type") or observation.get("type") or msg.get("event_type") or ""

                if evt_type in ("AgentThinkAction", "think", "thinking"):
                    text = action.get("thought") or action.get("content") or msg.get("content") or ""
                    if text:
                        yield sse_chunk("thinking_delta", {"step": step, "chunk": text})
                        yield sse_chunk("thought", {"step": step, "text": text})

                elif evt_type in ("CmdRunAction", "run_command", "cmd"):
                    cmd = action.get("command") or action.get("cmd") or action.get("content") or "bash"
                    step += 1
                    yield sse_chunk("tool_start", {"step": step, "name": "bash", "args": {"command": cmd}})

                elif evt_type in ("CmdOutputObservation", "cmd_output"):
                    output = observation.get("content") or observation.get("output") or msg.get("content") or ""
                    yield sse_chunk("tool_progress", {"step": step, "name": "bash", "partial": output})
                    yield sse_chunk("tool_result", {"step": step, "name": "bash", "ok": observation.get("exit_code", 0) == 0, "result": output, "error": output if observation.get("exit_code", 0) > 0 else None})

                elif evt_type in ("FileWriteAction", "write_file"):
                    path = action.get("path") or action.get("file") or "file"
                    step += 1
                    yield sse_chunk("tool_start", {"step": step, "name": "write_file", "args": {"path": path, "content": action.get("content", "")}})

                elif evt_type == "FileWriteObservation":
                    yield sse_chunk("tool_result", {"step": step, "name": "write_file", "ok": True, "result": {"path": observation.get("path", "file"), "success": True}})

                elif evt_type in ("FileReadAction", "read_file"):
                    path = action.get("path") or action.get("file") or "file"
                    step += 1
                    yield sse_chunk("tool_start", {"step": step, "name": "read_file", "args": {"path": path}})

                elif evt_type == "FileReadObservation":
                    yield sse_chunk("tool_result", {"step": step, "name": "read_file", "ok": True, "result": {"path": observation.get("path", "file"), "content": observation.get("content", "")}})

                elif evt_type in ("AgentFinishAction", "assistant", "final_response"):
                    chunk = action.get("response") or action.get("content") or msg.get("content") or ""
                    if chunk:
                        full_answer += chunk
                        yield sse_chunk("assistant_delta", {"step": step, "chunk": chunk})

                elif evt_type == "status" and msg.get("status") == "completed":
                    if full_answer:
                        yield sse_chunk("assistant", {"step": step, "text": full_answer})
                    yield sse_chunk("done", {"reason": "complete", "steps": step})
                    break

                elif evt_type == "error" or (evt_type == "status" and msg.get("status") == "error"):
                    err_msg = msg.get("message") or msg.get("content") or msg.get("error") or "OpenHands runtime error"
                    yield sse_chunk("error", {"message": err_msg})
                    yield sse_chunk("done", {"reason": "engine-error", "steps": step})
                    break

    except Exception as e:
        print(f"[OpenHands Bridge] WS stream error: {e}")
        yield sse_chunk("error", {"message": str(e)})
        yield sse_chunk("done", {"reason": "engine-error", "steps": step})

@app.post("/api/chat")
@app.post("/api/agent/chat")
@app.post("/api/chat-pi")
async def chat_endpoint(request: Request):
    data = await request.json()
    history = data.get("history", [])
    last_user_msg = next((m for m in reversed(history) if m.get("role") == "user"), None)
    prompt = last_user_msg.get("content") if last_user_msg else data.get("prompt", "hi")
    model = data.get("model") or (data.get("providerInput", {}).get("model")) or "glm-4.5-flash"
    workspace_scope = data.get("chatId", "")
    
    provider = data.get("providerInput") or data.get("provider") or get_active_key() or {}

    async with httpx.AsyncClient() as client:
        conv = await create_conversation(client, prompt, model, workspace_scope, provider)
        conv_id = conv.get("id") or conv.get("conversation_id") or workspace_scope or str(int(time.time()))
        await start_conversation(client, conv_id)

    return StreamingResponse(event_stream_generator(conv_id, model), media_type="text/event-stream")

@app.post("/api/chat/stop")
@app.post("/api/agent/chat/stop")
async def stop_endpoint(request: Request):
    data = await request.json()
    conv_id = data.get("chatId") or data.get("id")
    if not conv_id:
        raise HTTPException(status_code=400, detail="chatId required")
    url = f"{OPENHANDS_SERVER}/api/conversations/{conv_id}/stop"
    async with httpx.AsyncClient() as client:
        try:
            await client.post(url, json={}, timeout=5.0)
            return {"ok": True}
        except:
            return {"ok": False}

# ── Раздача статики React UI (Vite Build) ──
if os.path.exists("/app/ui/dist"):
    app.mount("/", StaticFiles(directory="/app/ui/dist", html=True), name="ui")
elif os.path.exists("./ui/dist"):
    app.mount("/", StaticFiles(directory="./ui/dist", html=True), name="ui")
