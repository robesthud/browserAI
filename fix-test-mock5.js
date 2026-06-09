import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// The test is failing because the category of `read_file` is 'read', but `cat !== 'ask'` handles that.
// The real issue might be that invokeTool mock is returning { ok: true } instead of failing.
// Let's verify our invokeTool mock in the test.

const mockStr = `vi.mock('../server/agentTools.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    invokeTool: vi.fn(async (tool, args, opts) => {
      opts?.onStdout?.('mock stdout progress')
      if (tool === 'read_file' && args.path === 'wrong.txt') {
         return { ok: false, error: 'File not found' }
      }
      return { ok: true, result: 'mocked tool result' }
    })
  }
})`

code = code.replace(
  /vi\.mock\('\.\.\/server\/agentTools\.js', async \(importOriginal\) => \{[\s\S]*?\}\)\n  \}\n\}\)/,
  mockStr
)

fs.writeFileSync('tests/error-recovery.test.js', code)
