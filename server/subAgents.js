/**
 * subAgents.js
 *
 * Cline-style `use_subagents` tool: spawn up to 5 focused, in-process
 * sub-agents in parallel, each with its own prompt. Each sub-agent gets
 * a SHRUNK toolset (read-only by default: list_files, read_file,
 * search_files, web_search, web_fetch, kb_search) and runs against the
 * SAME provider as the parent.
 *
 * Why: when the user says "audit these 20 files for X" or "explore the
 * repo and tell me how Y works", spawning 5 sub-agents that each read
 * a handful of files in parallel and return a 200-word summary saves
 * 70-90 % of the parent agent's context budget vs reading everything
 * inline.
 *
 * Sub-agents do NOT see the parent's chat history, do NOT call write
 * tools, do NOT call ops/git/deploy tools. They return a string. The
 * parent agent gets the strings back and decides what to do.
 *
 * Implementation note: we reuse callLLM + invokeTool from the existing
 * stack, not the full SSE agentLoop — sub-agents don't stream to the
 * client, they just produce a final summary. Hard caps: 8 steps,
 * 60 s wall-clock, 12 KB final answer.
 */
import { callLLM, supportsNativeTools } from './llmClient.js'
// NB: avoid a static `import { invokeTool } from './agentTools.js'` —
// agentTools.js dynamically registers OUR exported USE_SUBAGENTS_TOOL,
// which makes the import graph cyclic. We resolve invokeTool lazily
// at call-time instead.
let _invokeTool = null
async function getInvoke() {
  if (_invokeTool) return _invokeTool
  const mod = await import('./agentTools.js')
  _invokeTool = mod.invokeTool
  return _invokeTool
}

const SUBAGENT_TOOLS = new Set([
  'list_files', 'find_projects', 'read_file', 'search_files',
  'web_search', 'web_fetch', 'kb_search', 'recall_facts',
  'analyze_image', 'file_history',
])

const SUBAGENT_SYSTEM = `You are a focused BrowserAI sub-agent. You were spawned by a parent agent to investigate one narrow question and report back.

Constraints:
  • You have read-only tools. You CANNOT write files, run shell, deploy, or commit. If the parent's prompt asks you to do those things, say so plainly and stop.
  • You have at most 8 tool calls and 60 seconds. Use them well: parallel \`read_file\` calls in a single turn, narrow \`search_files\` queries, no exploration for its own sake.
  • Your final answer is a short, dense summary the parent can act on. Maximum ~200 words. Include concrete file paths, line numbers, function names — the parent needs facts, not vibes.

Tool format: <xai:function_call><xai:tool_name>NAME</xai:tool_name><parameter name="K">V</parameter></xai:function_call>. Parallel tools allowed.

When you have enough to answer, reply in plain markdown (no further tool call) and that is your final report. Stay terse.`

const XML_TOOL_CALL_RE = /<(?:xai:function_call|tool_use|function_call)([^>]*)>([\s\S]*?)<\/(?:xai:function_call|tool_use|function_call)>/gi

function parseXmlCallsSimple(text) {
  const calls = []
  let m
  while ((m = XML_TOOL_CALL_RE.exec(text || '')) != null) {
    const content = m[2] || ''
    const nameMatch =
      content.match(/<xai:tool_name>([^<]+)<\/xai:tool_name>/i) ||
      content.match(/<tool_name>([^<]+)<\/tool_name>/i)
    if (!nameMatch) continue
    const tool = nameMatch[1].trim()
    const params = {}
    const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi
    let pm
    while ((pm = paramRe.exec(content)) != null) {
      params[pm[1]] = pm[2]
    }
    calls.push({ tool, args: params })
  }
  return calls
}

async function runOneSubagent({ prompt, provider, signal, userId }) {
  const convo = [
    { role: 'system', content: SUBAGENT_SYSTEM },
    { role: 'user',   content: String(prompt || '').slice(0, 4000) },
  ]
  const deadline = Date.now() + 60_000
  const stats = { tools: 0, llm: 0, promptTokens: 0, completionTokens: 0 }

  for (let step = 1; step <= 8; step++) {
    if (signal?.aborted) return { ok: false, error: 'cancelled', stats }
    if (Date.now() > deadline) return { ok: false, error: 'deadline', stats }

    let reply
    try {
      reply = await callLLM({
        baseUrl: provider.baseUrl, apiKey: provider.apiKey,
        authType: provider.authType || 'bearer',
        authHeader: provider.authHeader || '',
        extraHeaders: provider.extraHeaders || {},
        model: provider.model,
        messages: convo,
        temperature: 0.2,
      })
    } catch (e) {
      return { ok: false, error: 'llm: ' + (e.message || String(e)), stats }
    }
    stats.llm += 1
    stats.promptTokens     += Number(reply?.usage?.prompt || 0)
    stats.completionTokens += Number(reply?.usage?.completion || 0)

    const text = String(reply?.text || '')
    const calls = parseXmlCallsSimple(text)
    if (!calls.length) {
      // Final answer.
      return { ok: true, text: text.trim().slice(0, 12_000), stats }
    }

    // Filter to allowed tools only; run in parallel.
    const allowed = calls.filter((c) => SUBAGENT_TOOLS.has(c.tool))
    if (!allowed.length) {
      convo.push({ role: 'assistant', content: text })
      convo.push({ role: 'user', content: 'Tool not permitted in sub-agent context. Use only: ' + [...SUBAGENT_TOOLS].join(', ') + '. Or finish with a final markdown answer.' })
      continue
    }
    convo.push({ role: 'assistant', content: text })

    const invokeTool = await getInvoke()
    const results = await Promise.all(allowed.map(async (c) => {
      stats.tools += 1
      try {
        const out = await invokeTool(c.tool, c.args, { signal, userId })
        return { tool: c.tool, ok: !!out?.ok, body: out?.result ?? out?.error ?? '' }
      } catch (e) {
        return { tool: c.tool, ok: false, body: e.message || String(e) }
      }
    }))
    const observation = results.map((r) => {
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      return `[${r.tool}${r.ok ? '' : ' FAILED'}]\n${String(body).slice(0, 3000)}`
    }).join('\n\n---\n\n')
    convo.push({ role: 'user', content: observation })
  }
  return { ok: false, error: 'max steps reached without final answer', stats }
}

/**
 * Run up to 5 sub-agents concurrently.
 * @param {object} opts
 * @param {string[]} opts.prompts
 * @param {object}   opts.provider — same shape as runAgent's provider
 * @param {AbortSignal} [opts.signal]
 * @param {string}   [opts.userId]
 * @returns {Promise<Array<{ ok, text?, error?, stats }>>}
 */
export async function runSubagents({ prompts, provider, signal, userId }) {
  const arr = (Array.isArray(prompts) ? prompts : [prompts])
    .filter((p) => p && String(p).trim())
    .slice(0, 5)
  if (!arr.length) return []
  return Promise.all(arr.map((p) => runOneSubagent({ prompt: p, provider, signal, userId })))
}

/**
 * Tool descriptor to register in agentTools.TOOLS so the parent agent
 * can call it like any other tool. We bind it to the live provider at
 * call-time via the args._provider field, populated by agentLoop.
 */
export const USE_SUBAGENTS_TOOL = {
  description: 'Spawn up to 5 focused, read-only sub-agents in parallel. Each gets its own prompt and returns a short summary. Use when you need to read many files / explore many areas to answer a single question — saves 70-90 % of your own context budget vs reading them inline. Sub-agents cannot write/commit/deploy.',
  params: {
    prompt_1: { type: 'string', required: true,  description: 'First sub-agent prompt (what to investigate / summarise).' },
    prompt_2: { type: 'string', optional: true,  description: 'Optional second sub-agent prompt.' },
    prompt_3: { type: 'string', optional: true,  description: 'Optional third sub-agent prompt.' },
    prompt_4: { type: 'string', optional: true,  description: 'Optional fourth sub-agent prompt.' },
    prompt_5: { type: 'string', optional: true,  description: 'Optional fifth sub-agent prompt.' },
  },
  handler: async (args = {}) => {
    const prompts = [args.prompt_1, args.prompt_2, args.prompt_3, args.prompt_4, args.prompt_5].filter(Boolean)
    const provider = args._provider
    if (!provider?.baseUrl || !provider?.apiKey) {
      return { ok: false, error: 'use_subagents: no provider available (internal: _provider not injected)' }
    }
    const results = await runSubagents({
      prompts, provider, signal: args._signal, userId: args._userId,
    })
    const out = results.map((r, i) => {
      const head = `## Sub-agent ${i + 1} (${r.ok ? 'ok' : 'failed'}) — ${r.stats?.llm || 0} LLM, ${r.stats?.tools || 0} tools`
      const body = r.ok ? (r.text || '(empty)') : `ERROR: ${r.error}`
      return head + '\n\n' + body
    }).join('\n\n========================================\n\n')
    return { ok: true, result: out }
  },
}

export default { runSubagents, USE_SUBAGENTS_TOOL }
