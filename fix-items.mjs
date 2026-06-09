import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')
code = code.replace(
  "const items = []\n\n                  const items = []",
  "const items = []"
)
fs.writeFileSync('src/components/MessageList.jsx', code)
