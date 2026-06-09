import fs from 'fs'

let loop = fs.readFileSync('server/agentLoop.js', 'utf8')
loop = loop.replace(
  "console.log('EVALUATING HEALING:', { ok: r.ok, pushed: pushedBackThisTurn, aborted, cat }); if (!r.ok && !pushedBackThisTurn && !aborted && cat !== 'ask') {",
  "if (!r.ok && !pushedBackThisTurn && !aborted && cat !== 'ask') {"
)
fs.writeFileSync('server/agentLoop.js', loop)

let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')
// The mock return for llmClient.callLLMStream was returning an empty toolCall!
// Wait, no: `toolCalls: [{ name: 'read_file', args: { path: 'wrong.txt' }, id: 't2', raw: {} }]`
// Let's check `parseXmlFunctionCalls` or similar... Wait, Native tool calls are not parsing correctly?
// In `agentLoop.js`: `useNativeTools` is mocked as `true`.
// `calls.push({ tool: tc.name, args: tc.args || {}, nativeId: tc.id, nativeRaw: tc.raw })`
// It checks `if (TOOLS[tc.name] || (extraTools && extraTools[tc.name]))`
// BUT `read_file` is not in TOOLS because `agentTools.js` is mocked and we only exported `invokeTool` !!!
// YES! The mock of `agentTools.js` is missing `TOOLS: { read_file: {} }`

code = code.replace(
  "invokeTool: vi.fn(async (tool, args, opts) => {",
  "TOOLS: { read_file: {} },\n    invokeTool: vi.fn(async (tool, args, opts) => {"
)
fs.writeFileSync('tests/error-recovery.test.js', code)
