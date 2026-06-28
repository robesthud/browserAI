# SSE Contract — BrowserAI ↔ Client

**Version:** 1.0  
**Last updated:** 2026-06-28  
**Source:** core/server.py + ui/src/lib/agentStream.js

This contract **MUST NOT** change without versioning.

## Event Types (in order of appearance)

### 1. stream_protocol (first event)
```json
{
  "event": "stream_protocol",
  "data": {
    "version": "1.0",
    "chatId": "string",
    "conversationId": "string?"
  }
}
```

### 2. agent_state
```json
{
  "event": "agent_state",
  "data": {
    "state": "running" | "paused" | "finished" | "error",
    "step": number,
    "max_steps": number
  }
}
```

### 3. thinking / thinking_delta
```json
{
  "event": "thinking" | "thinking_delta",
  "data": {
    "text": "string"
  }
}
```

### 4. thought
```json
{
  "event": "thought",
  "data": {
    "content": "string"
  }
}
```

### 5. tool_preview
```json
{
  "event": "tool_preview",
  "data": {
    "tool": "string",
    "args": object
  }
}
```

### 6. tool_start
```json
{
  "event": "tool_start",
  "data": {
    "id": "string",
    "name": "string",
    "args": object
  }
}
```

### 7. tool_progress
```json
{
  "event": "tool_progress",
  "data": {
    "id": "string",
    "progress": number,
    "message": "string?"
  }
}
```

### 8. tool_result
```json
{
  "event": "tool_result",
  "data": {
    "id": "string",
    "name": "string",
    "result": "string" | object,
    "is_error": boolean
  }
}
```

### 9. assistant_delta
```json
{
  "event": "assistant_delta",
  "data": {
    "chunk": "string"
  }
}
```

### 10. assistant
```json
{
  "event": "assistant",
  "data": {
    "text": "string",
    "finish_reason": "string?"
  }
}
```

### 11. ask_user
```json
{
  "event": "ask_user",
  "data": {
    "question": "string",
    "options": string[]?
  }
}
```

### 12. done (always last)
```json
{
  "event": "done",
  "data": {
    "reason": "complete" | "error" | "stopped" | "busy",
    "chatId": "string",
    "conversationId": "string?",
    "error": "string?"
  }
}
```

### 13. error
```json
{
  "event": "error",
  "data": {
    "message": "string",
    "code": "string?"
  }
}
```

## Wire Format
- Server-Sent Events (text/event-stream)
- Each event: `event: <name>\ndata: <json>\n\n`
- Client must handle `data:` lines and parse JSON

## Important Rules
- `stream_protocol` is **always** the first message
- `done` is **always** the last message
- All tool events carry stable `id`
- `assistant_delta` may be sent multiple times before `assistant`
- Clients must be resilient to reconnects

**Do not break this contract.**
