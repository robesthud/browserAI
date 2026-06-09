const fs = require('fs')
let file = fs.readFileSync('tests/sse-stream-shape.test.js', 'utf8')
file = file.replace(
  "vi.mock('../server/costTracker.js', () => ({",
  "vi.mock('../server/costTracker.js', async (importOriginal) => {\n  const mod = await importOriginal()\n  return {\n    ...mod,"
)
file = file.replace(
  "chatTotalUsd: vi.fn(() => 0),\n}))",
  "chatTotalUsd: vi.fn(() => 0),\n  }\n})"
)
fs.writeFileSync('tests/sse-stream-shape.test.js', file)
