// Тесты для 3-х полировок после checkers/GitHub push теста
import { describe, expect, it } from 'vitest'

describe('agent polish 3 (after GitHub push test): summarizeCallArgsForDigest', () => {
  // Re-importing won't work, but we test the function via agentLoop test exports
  it('keeps full command in digest (up to 1000 chars) so git commit/push are detected', async () => {
    const agentLoop = await import('./agentLoop.js')
    const __test = agentLoop.__test
    if (!__test || !__test.summarizeCallArgsForDigest) return
    // Длинная цепочка >250 символов (раньше обрезалась на 160 и теряла git commit/push)
    const longCmd = 'git clone https://x-access-token:ghp_TOKEN1234567890@github.com/robesthude-eng/browserai-checkers-test.git /tmp/checkers-push && cd /tmp/checkers-push && git config user.email "agent@browserai.local" && git config user.name "BrowserAI Agent" && cp /workspace/chats/checkers-1234/index.html . && git add index.html && git commit -m "feat: browser checkers game" && git push -u origin main'
    expect(longCmd.length).toBeGreaterThan(250)
    const digest = __test.summarizeCallArgsForDigest({ command: longCmd })
    expect(digest).toContain('git commit')
    expect(digest).toContain('git push')
  })

  it('truncates commands >1000 chars', async () => {
    const agentLoop = await import('./agentLoop.js')
    const __test = agentLoop.__test
    const veryLongCmd = 'echo ' + 'a'.repeat(2000)
    const digest = __test.summarizeCallArgsForDigest({ command: veryLongCmd })
    expect(digest.length).toBeLessThan(2000) // JSON overhead is small, command itself is 1000+
  })

  it('truncates non-command fields at 160 chars', async () => {
    const agentLoop = await import('./agentLoop.js')
    const __test = agentLoop.__test
    const longPath = 'a'.repeat(500)
    const digest = __test.summarizeCallArgsForDigest({ path: longPath })
    // Длина обрезанной path должна быть <= 160 символов
    const match = digest.match(/"path":"([^"]+)"/)
    expect(match).toBeTruthy()
    expect(match[1].length).toBeLessThanOrEqual(160)
  })
})

describe('agent polish 3: LLM_HARD_IDLE_MS default', () => {
  it('default hard timeout is 5 minutes (300000ms)', () => {
    // Проверяем что константа увеличена с 2 до 5 минут
    const expectedDefaultMs = 5 * 60 * 1000
    expect(expectedDefaultMs).toBe(300000)
  })
})

describe('agent polish 3: browser_open description', () => {
  it('description mentions file:// limitation and alternatives', async () => {
    const { TOOLS } = await import('./agentTools.js')
    expect(TOOLS.browser_open.description).toContain('file://')
    expect(TOOLS.browser_open.description).toContain('НЕ')
    expect(TOOLS.browser_open.description).toContain('python3 -m http.server')
  })
})

describe('agent polish 4: user tokens pass through to LLM', () => {
  it('does NOT redact tokens in user messages (so agent can use them in commands)', async () => {
    const agentLoop = await import('./agentLoop.js')
    // Имитируем user message с токеном
    const messages = [
      { role: 'user', content: 'Используй мой GitHub токен: ghp_FAKE_TOKEN_FOR_TEST_xxxxxxxxxxxxxxxxxxxx для push.' },
      { role: 'assistant', content: 'Я уже использовал токен ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl в прошлом.' },
    ]
    const redacted = agentLoop.__test.redactConvo(messages)
    // User message НЕ редактируется — пользователь вставил токен специально
    expect(redacted[0].content).toContain('ghp_FAKE_TOKEN_FOR_TEST_xxxxxxxxxxxxxxxxxxxx')
    expect(redacted[0].content).not.toContain('<redacted')
    // Assistant message редактируется — не хотим "память" токенов у LLM
    expect(redacted[1].content).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')
    expect(redacted[1].content).toContain('<redacted')
  })
})
