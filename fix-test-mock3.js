import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

code = code.replace(
  "vi.mock('../server/agentTools.js', () => {",
  "vi.mock('../server/agentTools.js', async (importOriginal) => {\n  const actual = await importOriginal()\n  return {\n    ...actual,"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
