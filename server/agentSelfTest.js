/**
 * agentSelfTest.js
 *
 * Backend-only automated diagnostic for the Agent Mode runtime layers.
 * Verifies that the provider adapters, tool router, sandbox policy,
 * and context manager work as expected WITHOUT making real LLM calls.
 *
 * Replaces vibes-based testing with a strict schema-check suite.
 */
import { getProviderCapabilities } from './llmClient.js'
import { validateToolCall, createAgentState } from './agentCore.js'
import { redactSecrets } from './sandboxPolicy.js'
import { upsertAgentStateDigest } from './contextManager.js'
import { registerQuestion, answerQuestion } from './askUserRegistry.js'
import { writeFileContent, readWorkspaceFile, deleteItem } from './workspace.js'

export async function runAgentSelfTest({ userId, chatId } = {}) {
  const results = {
    schema: 'browserai.agent_self_test.v1',
    ok: true,
    userId,
    chatId,
    createdAt: new Date().toISOString(),
    passed: 0,
    failed: 0,
    checks: [],
  }

  async function check(name, fn) {
    const start = Date.now()
    try {
      await fn()
      results.passed += 1
      results.checks.push({ name, ok: true, durationMs: Date.now() - start })
    } catch (e) {
      results.failed += 1
      results.ok = false
      results.checks.push({ name, ok: false, error: e.message, durationMs: Date.now() - start })
    }
  }

  // 1. Provider Layer
  await check('provider_capabilities_detection', async () => {
    const caps = getProviderCapabilities('https://api.openai.com/v1', 'gpt-4o')
    if (caps.kind !== 'openai-compatible') throw new Error('Bad provider kind')
    if (!caps.features.nativeTools) throw new Error('Native tools should be enabled for OpenAI')
  })

  // 2. Tool Router
  await check('tool_router_validation', async () => {
    // В Agent Mode пути нормализуются. Проверяем, что абсолютный путь /workspace/foo.js 
    // превращается в foo.js
    const v = validateToolCall('read_file', { path: '/workspace/foo.js' })
    if (!v.ok) throw new Error(`Validator returned error: ${v.error}`)
    if (v.args.path !== 'foo.js') throw new Error(`Prefix cleanup failed. Expected "foo.js", got: ${v.args.path}`)
    
    // Проверка на выход за пределы папки
    const v2 = validateToolCall('read_file', { path: '../../etc/passwd' })
    if (v2.ok) throw new Error('Should have rejected path traversal')
  })

  // 3. Sandbox Policy
  await check('secret_redaction', async () => {
    const sensitive = 'My key is ghp_1234567890abcdefGHJK'
    const redacted = redactSecrets(sensitive)
    if (redacted.includes('ghp_')) throw new Error('Redaction failed: sensitive pattern still present')
  })

  // 4. Context & Memory
  await check('context_digest_integrity', async () => {
    const convo = [{ role: 'system', content: 'Sys' }]
    const state = createAgentState({ history: [{ role: 'user', content: 'Goal' }] })
    upsertAgentStateDigest(convo, state, [])
    if (convo.length !== 2) throw new Error('Digest not inserted')
    if (!convo[1].content.includes('Authoritative task-level memory')) throw new Error('Wrong digest marker')
  })

  // 5. Ask User Registry
  await check('ask_user_lifecycle', async () => {
    const { id, promise } = registerQuestion({ kind: 'ask_user', userId, chatId, question: 'Yes?' })
    answerQuestion(id, { text: 'Yes' }, { userId })
    const ans = await promise
    if (ans?.text !== 'Yes') throw new Error('Answer mismatch or rejected')
  })

  // 6. Workspace Scoping
  if (chatId) {
    check('workspace_scoped_io', async () => {
      const testFile = `self-test-${Date.now()}.txt`
      await writeFileContent(testFile, 'hello')
      const read = await readWorkspaceFile(testFile)
      if (read.text !== 'hello') throw new Error('Read/Write failed')
      await deleteItem(testFile)
    })
  }

  return results
}
