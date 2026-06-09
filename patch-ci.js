const fs = require('fs')
let file = fs.readFileSync('.github/workflows/ci.yml', 'utf8')
file = file.replace(
  "run: npm test",
  "run: npm test\n        env:\n          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}\n          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}\n          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}"
)
fs.writeFileSync('.github/workflows/ci.yml', file)
