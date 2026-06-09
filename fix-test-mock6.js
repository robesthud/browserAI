import fs from 'fs'
let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')

// The test is failing because the mocked llmClient returns 'mock' which is caught by supportsNativeTools and might not be treated as a known provider for the execution loop? Wait, supportsNativeTools returns true.
// Actually, why is tool_result empty? Did the tool even run?
// Ah! In v2.24 we changed the return of the map to `return { call, pushedBack: true }` when there is a schema error, and ALSO when there is an execution error.
// BUT wait, execution error only pushes back if `cat !== 'ask'`. What is `cat` for `read_file`? It's `read`.
// Let's check `isDev` or `aborted`?
// Let's add a console.log in the `invokeTool` mock to see if it even runs.

code = code.replace(
  "if (tool === 'read_file' && args.path === 'wrong.txt') {",
  "console.log('INVOKED TOOL:', tool, args);\n      if (tool === 'read_file' && args.path === 'wrong.txt') {"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
