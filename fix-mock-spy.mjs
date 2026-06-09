import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

code = code.replace(
  "vi.mock('../server/agentTools.js', () => {",
  "vi.mock('../server/agentTools.js', () => {"
)

// We need to actually mock invokeTool for this test to fail execution.
const invokeMock = `
vi.mock('../server/agentTools.js', () => {
  return {
    invokeTool: vi.fn(async (name, args) => {
      if (name === 'read_file' && args.path === 'wrong.txt') {
        return { ok: false, error: 'File not found' }
      }
      return { ok: true, result: 'mocked' }
    })
  }
})
`

code = code.replace(
  "vi.mock('../server/costTracker.js', () => {",
  invokeMock + "\n\nvi.mock('../server/costTracker.js', () => {"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
