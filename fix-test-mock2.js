import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

code = code.replace(
  "vi.mock('../server/agentTools.js', () => {",
  "vi.mock('../server/agentTools.js', () => {\n  let calls = 0"
)

code = code.replace(
  "invokeTool: vi.fn(async (tool, args, opts) => {\n      opts?.onStdout?.('mock stdout progress')\n      return { ok: true, result: 'mocked tool result' }",
  "invokeTool: vi.fn(async (tool, args, opts) => {\n      calls++\n      opts?.onStdout?.('mock stdout progress')\n      if (tool === 'read_file' && calls === 1) return { ok: false, error: 'File not found' }\n      return { ok: true, result: 'mocked tool result' }"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
