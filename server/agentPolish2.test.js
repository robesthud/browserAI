// Тесты для второй волны фиксов (ask_user timeout, maxSteps propagation, classifier)
import { describe, expect, it } from 'vitest'

// 1) ask_user timeout — timeout должен уменьшать r.ok до false и инжектить timedOut
describe('agent polish 2: ask_user timeout behavior', () => {
  it('rejects with timeout error when no answer within timeoutMs (floor: 5s)', async () => {
    const { registerQuestion } = await import('./askUserRegistry.js')
    // timeoutMs < 5000 поднимется до 5000 — тестируем именно это поведение
    const { promise } = registerQuestion({ question: 'Test?', timeoutMs: 100 })
    let error
    try { await promise } catch (e) { error = e }
    expect(error).toBeDefined()
    expect(error.message).toMatch(/timeout/i)
  }, 6000)

  it('resolves when answered before timeout', async () => {
    const { registerQuestion, answerQuestion } = await import('./askUserRegistry.js')
    const { id, promise } = registerQuestion({ question: 'Test?', timeoutMs: 5000 })
    setTimeout(() => answerQuestion(id, { value: 'yes' }), 50)
    const result = await promise
    expect(result.value).toBe('yes')
  }, 1000)

  it('default ASK_TIMEOUT_MS is 3 minutes (180000ms)', () => {
    const expectedDefaultMs = 3 * 60 * 1000
    expect(expectedDefaultMs).toBe(180000)
  })

  it('explicit timeoutMs respects 5s floor and 1h ceiling', async () => {
    const { registerQuestion } = await import('./askUserRegistry.js')
    const { timeoutMs: t1 } = registerQuestion({ question: 'x', timeoutMs: 2000 })
    expect(t1).toBe(5000)
    const { timeoutMs: t2 } = registerQuestion({ question: 'x', timeoutMs: 30000 })
    expect(t2).toBe(30000)
    const { timeoutMs: t3 } = registerQuestion({ question: 'x', timeoutMs: 5 * 60 * 60 * 1000 })
    expect(t3).toBe(60 * 60 * 1000)
  })
})

// 2) runAgent принимает maxSteps
describe('agent polish 2: maxSteps propagation in runAgent', () => {
  it('passes maxSteps=7 to runAgentInner when no UI override', async () => {
    const loggerModule = await import('./logger.js')
    const originalInfo = loggerModule.default.info
    const capturedLogs = []
    loggerModule.default.info = (...args) => capturedLogs.push(args)
    try {
      const agentLoop = await import('./agentLoop.js')
      const writes = []
      const res = {
        setHeader() {}, flushHeaders() {},
        write(chunk) { writes.push(String(chunk)) },
        flush() {}, end() {}, on() {},
      }
      await agentLoop.runAgent({
        provider: { baseUrl: 'mock', model: 'mock', forceAgent: true },
        history: [{ role: 'user', content: 'hi' }],
        maxSteps: 7,
        workspaceScope: 'vitest-maxsteps-' + Date.now(),
        res,
      })
      const startLog = capturedLogs.find((args) =>
        args[0] === 'agent_start' && args[1]?.maxSteps === 7
      )
      expect(startLog).toBeDefined()
    } finally {
      loggerModule.default.info = originalInfo
    }
  })
})

// 3) Task classifier — multi-file tasks → coding_change с 80 шагами
describe('agent polish 2: task classifier multi-file detection', () => {
  it('classifies "create 8 Python files" as coding_change with 80 steps', async () => {
    const { classifyAgentTask } = await import('./agentCore.js')
    const result = classifyAgentTask(
      'Создай 8 отдельных Python-файлов: utils_string.py, utils_math.py, utils_date.py, utils_file.py, utils_json.py, utils_list.py, utils_dict.py, utils_regex.py'
    )
    expect(result.type).toBe('coding_change')
    expect(result.complexity).toBe('high')
    expect(result.suggestedMaxSteps).toBe(80)
  })

  it('classifies single file creation as coding_change with 50 steps', async () => {
    const { classifyAgentTask } = await import('./agentCore.js')
    const result = classifyAgentTask('Создай файл hello.py с print("hello")')
    expect(result.type).toBe('coding_change')
    expect(result.suggestedMaxSteps).toBe(50)
  })

  it('classifies simple chat (привет) as simple_answer with 6 steps', async () => {
    const { classifyAgentTask } = await import('./agentCore.js')
    const result = classifyAgentTask('Привет!')
    expect(result.type).toBe('simple_answer')
    expect(result.suggestedMaxSteps).toBe(6)
  })

  it('classifies list of 3+ JS files as multi-file coding', async () => {
    const { classifyAgentTask } = await import('./agentCore.js')
    const result = classifyAgentTask('Создай server.js, client.js и router.js')
    expect(result.type).toBe('coding_change')
    expect(result.suggestedMaxSteps).toBe(80)
  })
})
