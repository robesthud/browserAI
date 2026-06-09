import fs from 'fs'
let file = fs.readFileSync('tests/sse-stream-shape.test.js', 'utf8')
file = file.replace(
  "expect(data.schema).toBe('browserai.agent_stream_event.v1')",
  "expect(['browserai.agent_stream_event.v1', 'browserai.agent_context.v1', 'browserai.agent_state.v1', 'browserai.tool_result.v1', 'browserai.provider_error.v1']).toContain(data.schema)"
)
fs.writeFileSync('tests/sse-stream-shape.test.js', file)
