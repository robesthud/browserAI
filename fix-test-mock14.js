import fs from 'fs'

let code = fs.readFileSync('tests/error-recovery.test.js', 'utf8')
code = code.replace(
  "id: 't2', raw: {}",
  "id: 't2', raw: { type: 'function', function: { name: 'read_file', arguments: '{}' } }"
)
code = code.replace(
  "id: 't1', raw: {}",
  "id: 't1', raw: { type: 'function', function: { name: 'read_file', arguments: '{}' } }"
)

fs.writeFileSync('tests/error-recovery.test.js', code)
