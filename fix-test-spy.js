import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// When using vi.mock with an actual module, invokeTool might be overridden.
// But we already mocked agentTools entirely at the top of the file!
// So we can just change the existing mock behavior for this test.

code = code.replace(
  "vi.spyOn(agentTools, 'invokeTool').mockResolvedValueOnce({ ok: false, error: 'File not found' })",
  "agentTools.invokeTool.mockResolvedValueOnce({ ok: false, error: 'File not found' })"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
