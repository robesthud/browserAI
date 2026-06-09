const fs = require('fs')
let file = fs.readFileSync('tests/sse-stream-shape.test.js', 'utf8')
file = file.replace(
  "vi.mock('../server/llmClient.js', async (importOriginal) => {\n  const mod = await importOriginal()\n  return {\n    ...mod,",
  "vi.mock('../server/llmClient.js', () => ({\n"
)
file = file.replace(
  "    })\n  }\n})",
  "    })\n  }))"
)
fs.writeFileSync('tests/sse-stream-shape.test.js', file)
