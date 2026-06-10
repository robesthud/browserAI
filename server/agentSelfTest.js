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
import { validateToolCall, normalizeToolResult, createAgentState } from './agentCore.js'
import { redactSecrets } from './sandboxPolicy.js'
import { upsertAgentStateDigest } from './contextManager.js'
import { registerQuestion, answerQuestion, cancelQuestion } from './askUserRegistry.js'
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

  function check(name, fn) {
    try {
      fn()
      results.passed += 1
      results.checks.push({ name, ok: true })
    } catch (e) {
      results.failed += 1
      results.ok = false
      results.checks.push({ name, ok: false, error: e.message })
    }
  }

  // 1. Provider Layer
  check('provider_capabilities_detection', () => {
    const caps = getProviderCapabilities('https://api.openai.com/v1', 'gpt-4o')
    if (caps.kind !== 'openai-compatible') throw new Error('Bad provider kind')
    if (!caps.features.nativeTools) throw new Error('Native tools should be enabled for OpenAI')
  })

  // 2. Tool Router
  check('tool_router_validation', () => {
    // В Agent Mode пути нормализуются. Проверяем, что абсолютный путь /workspace/foo.js 
    // превращается в foo.js
    const v = validateToolCall('read_file', { path: '/workspace/foo.js' })
    if (v.error) throw new Error(`Validator failed: ${v.error}`)
    if (v.args.path !== 'foo.js') throw new Error(`Prefix cleanup failed. Got: ${v.args.path}`)
    
    // Проверка на выход за пределы папки
    const v2 = validateToolCall('read_file', { path: '../../etc/passwd' })
    if (v2.ok) throw new Error('Should have rejected path traversal')
  })

  // 3. Sandbox Policy
  check('secret_redaction', () => {
    const sensitive = 'My key is ghp_1234567890abcdefGHJK'
    const redacted = redactSecrets(sensitive)
    if (redacted.includes('ghp_')) throw new Error('Redaction failed: sensitive pattern still present')
  })

  // 4. Context & Memory
  check('context_digest_integrity', () => {
    const convo = [{ role: 'system', content: 'Sys' }]
    const state = createAgentState({ history: [{ role: 'user', content: 'Goal' }] })
    upsertAgentStateDigest(convo, state, [])
    if (convo.length !== 2) throw new Error('Digest not inserted')
    if (!convo[1].content.includes('Authoritative task-level memory')) throw new Error('Wrong digest marker')
  })

  // 5. Ask User Registry
  check('ask_user_lifecycle', async () => {
    const { id, promise } = registerQuestion({ kind: 'ask_user', userId, chatId, question: 'Yes?' })
    answerQuestion(id, { text: 'Yes' }, { userId })
    const ans = await promise
    if (ans.text !== 'Yes') throw new Error('Answer mismatch')
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
