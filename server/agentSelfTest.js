import { validateToolCall } from './agentCore.js'
import { TOOLS } from './agentTools.js'
import { redactSecrets } from './sandboxPolicy.js'
import { readWorkspaceFile, writeFileContent, deleteItem, withWorkspaceScope } from './workspace.js'
import { renderAgentStateDigest } from './contextManager.js'
import { registerQuestion, answerQuestion, cancelQuestion, pendingCount } from './askUserRegistry.js'
import { getProviderCapabilities } from './llmClient.js'

async function test(name, fn) {
  const startedAt = Date.now()
  try {
    const result = await fn()
    return { name, ok: true, durationMs: Date.now() - startedAt, result: result || null }
  } catch (e) {
    return { name, ok: false, durationMs: Date.now() - startedAt, error: e?.message || String(e) }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function runAgentSelfTest({ userId = '', chatId = '' } = {}) {
  const scope = chatId || `selftest-${Date.now().toString(36)}`
  const checks = []

  checks.push(await test('provider-capabilities-openai-compatible', async () => {
    const c = getProviderCapabilities('https://api.openai.com/v1', 'gpt-4o')
    assert(c.kind === 'openai-compatible', 'expected openai-compatible')
    assert(c.features.streaming === true, 'expected streaming')
    assert(c.features.universalTools === true, 'expected universal tools')
    return { kind: c.kind, protocol: c.recommendedToolProtocol }
  }))

  checks.push(await test('tool-validation-required-param', async () => {
    const v = validateToolCall('read_file', {}, TOOLS.read_file)
    assert(v.ok === false, 'read_file without path must fail')
    assert(/path/.test(v.error), 'error must mention path')
    return { error: v.error }
  }))

  checks.push(await test('tool-validation-path-traversal', async () => {
    const v = validateToolCall('read_file', { path: '../secret.txt' }, TOOLS.read_file)
    assert(v.ok === false, 'path traversal must fail')
    return { error: v.error }
  }))

  checks.push(await test('tool-validation-coercion', async () => {
    const v = validateToolCall('bash', { command: 'echo ok', timeout: '2', cwd: '/test' }, TOOLS.bash)
    assert(v.ok === true, 'bash args should validate')
    assert(v.args.timeout === 2, 'timeout should coerce to number')
    assert(v.args.cwd === '/test', 'cwd should coerce to string')
    return { args: v.args, warnings: v.warnings }
  }))

  checks.push(await test('secret-redaction', async () => {
    const redacted = redactSecrets('token=github_pat_1234567890abcdefghijklmnopqrstuvwxyz password=superSecret123')
    assert(!redacted.includes('github_pat_1234567890'), 'github token must be redacted')
    assert(!redacted.includes('superSecret123'), 'password must be redacted')
    return { redacted }
  }))

  checks.push(await test('context-agent-state-digest', async () => {
    const digest = renderAgentStateDigest({
      status: 'running',
      goal: 'self-test goal',
      currentStep: 'verify digest',
      plan: { steps: [{ idx: 1, text: 'First', done: true }, { idx: 2, text: 'Second', done: false }], done: [1] },
      completedSteps: ['1. First'],
      touchedFiles: ['self-test.txt'],
      lastErrors: [],
      nextActions: ['finish'],
      toolStats: { total: 2, ok: 2, failed: 0 },
    }, [{ tool: 'read_file', ok: true }])
    assert(digest.includes('<arena-system-message>\nAuthoritative task-level memory (agent_state_digest):'), 'digest marker missing')
    assert(digest.includes('self-test goal'), 'goal missing')
    assert(digest.includes('recentTools'), 'recent tools missing')
    return { chars: digest.length }
  }))

  checks.push(await test('ask-user-registry-lifecycle', async () => {
    const before = pendingCount({ userId })
    const { id, promise } = registerQuestion({ userId, chatId: scope, question: 'Self-test?', timeoutMs: 30_000 })
    assert(pendingCount({ userId }) === before + 1, 'pending count must increment')
    const ok = answerQuestion(id, { selected: ['ok'] }, { userId })
    assert(ok, 'answer must resolve')
    const answer = await promise
    assert(answer.selected?.[0] === 'ok', 'answer payload mismatch')
    assert(pendingCount({ userId }) === before, 'pending count must return to before')
    return { idAnswered: id }
  }))

  checks.push(await test('ask-user-registry-cancel', async () => {
    const { id, promise } = registerQuestion({ userId, chatId: scope, question: 'Cancel?', timeoutMs: 30_000 })
    const ok = cancelQuestion(id, 'self-test cancel', { userId })
    assert(ok, 'cancel must return true')
    let rejected = false
    try { await promise } catch { rejected = true }
    assert(rejected, 'cancelled promise must reject')
    return { idCancelled: id }
  }))

  checks.push(await test('workspace-read-write-delete', async () => {
    return withWorkspaceScope(scope, async () => {
      const file = `self-test-${Date.now()}.txt`
      await writeFileContent(file, 'hello self-test')
      const read = await readWorkspaceFile(file)
      assert(read.text === 'hello self-test', 'workspace read mismatch')
      await deleteItem(file)
      return { file }
    })
  }))

  const ok = checks.every((c) => c.ok)
  return {
    schema: 'browserai.agent_self_test.v1',
    ok,
    userId: userId ? String(userId).slice(0, 8) : '',
    chatId: scope,
    createdAt: new Date().toISOString(),
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
    checks,
  }
}

export default { runAgentSelfTest }
