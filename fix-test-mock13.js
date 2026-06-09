import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// Is `read_file` handled correctly in `invokeTool` in agentTools?
// The mock overrides invokeTool but wait, there is `evaluateHealing`...
// The category of `read_file` is `read`. `cat !== 'ask'` is true.
// But the test output says:
// TOOL RESULTS: []
// Why is toolResults empty? 
// Because the LLM call returns `toolCalls: [{ name: 'read_file', args: { path: 'wrong.txt' }, id: 't2', raw: {} }]` but it doesn't execute?
// `validateToolCall(call.tool, call.args, toolDef)`
// `call.args` is `{ path: 'wrong.txt' }`. `toolDef` is `{ params: { path: { type: 'string', required: true } } }`.
// That is perfectly valid. `validation.ok` is true.
// But wait! Is `read_file` skipped because of approval gate? No, `read` is auto-approved by default.
// Wait, the output doesn't print "INVOKED TOOL: read_file { path: 'wrong.txt' }" for the SECOND test!
// Why not?
// Ah! Because `pushedBackThisTurn` is true? No, it's a new turn.
// Wait, `pushedBackThisTurn` is true from the previous test?
// No, the tests run isolated, but wait! The mock of llmClient.callLLMStream has mockImplementationOnce!
// In the first test: mockImplementationOnce is called TWICE. So it exhausts the first two.
// In the second test, it calls `.mockImplementationOnce` TWICE more.
// But wait... the first test only calls it once! Because it pushes back and then the loop calls it AGAIN!
// YES! The loop pushes back, calls it again, and consumes the second mock (Fixed it).
// But what if it didn't consume it?
// In the first test, `expect(llmClient.callLLMStream).toHaveBeenCalledTimes(2)` was removed.
// Let's clear the mock history!

code = code.replace(
  "describe('v2.24 - Advanced error recovery', () => {",
  "describe('v2.24 - Advanced error recovery', () => {\n  afterEach(() => { vi.clearAllMocks() })"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
