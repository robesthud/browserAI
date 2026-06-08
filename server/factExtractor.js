/**
 * Auto-fact-extractor.
 *
 * Runs in the background after every agent turn. Asks the same LLM
 * provider one tiny stateless question:
 *
 *   "Look at this conversation. List 0-3 concise facts about the user
 *    or the project that would be useful to remember in FUTURE chats.
 *    Each fact one line. No commentary. Empty if nothing notable."
 *
 * Anything the model returns goes through `rememberMemory` so the next
 * time the user says "продолжи" / "тот проект где мы…" / "помнишь мою
 * любимую модель?" the relevant memories surface via semantic recall.
 *
 * Deliberately tiny prompt + low temperature + 1-shot — kept under
 * ~300 prompt tokens so it adds <$0.001 per turn on most models.
 *
 * Best-effort: any failure (rate-limit, provider down, bad JSON) is
 * silently ignored. Memory is a nice-to-have, never blocks the user.
 */
import { callLLM } from './llmClient.js'
import { rememberMemory } from './semanticMemory.js'

const SYSTEM = [
  'You are a memory curator for a personal AI assistant.',
  'Read the conversation excerpt and return 0–3 SHORT facts about the user',
  'or their project that would be useful to remember in future chats.',
  '',
  'Pick ONLY:',
  '  • stable preferences ("I prefer Tailwind v3")',
  '  • recurring project context ("main repo: /opt/browserai")',
  '  • important decisions ("we use Postgres, not SQLite, in prod")',
  '  • stable identifiers ("Telegram chat id 7441134313 is mine")',
  '',
  'IGNORE one-off chitchat, error messages, tool output, prompts to you.',
  '',
  'Output strictly as one fact per line. NO numbering, NO bullets, NO',
  'commentary, NO empty lines. If nothing is worth remembering, output',
  'a single line: NOMEMORY',
].join('\n')

/**
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.chatId
 * @param {object} args.provider     same shape callLLM expects
 * @param {Array}  args.history      recent role/content messages
 */
export async function extractAndStore({ userId, chatId, provider, history }) {
  if (!userId || !provider?.baseUrl || !provider?.apiKey) return { stored: 0 }
  if (!Array.isArray(history) || history.length === 0) return { stored: 0 }

  // Only look at the last few turns — older stuff already had its chance.
  const tail = history.slice(-4)
    .filter((m) => m?.content && typeof m.content === 'string')
    .map((m) => `${m.role === 'assistant' ? 'A' : 'U'}: ${String(m.content).slice(0, 800)}`)
    .join('\n')
  if (!tail.trim()) return { stored: 0 }

  let reply
  try {
    reply = await callLLM({
      baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      authType: provider.authType || 'bearer',
      authHeader: provider.authHeader || '',
      extraHeaders: provider.extraHeaders || {},
      model: provider.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Conversation:\n${tail}\n\nFacts:` },
      ],
      temperature: 0.1,
    })
  } catch { return { stored: 0 } }

  const text = String(reply?.text || '').trim()
  if (!text || /^NOMEMORY$/i.test(text)) return { stored: 0 }
  const facts = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^nomemory$/i.test(l)).slice(0, 5)

  let stored = 0
  for (const f of facts) {
    // Strip leading bullet/dash/number if the model ignored the rules.
    const clean = f.replace(/^[-*•\d.)]\s+/, '').slice(0, 400)
    if (clean.length < 6) continue
    try {
      await rememberMemory(userId, clean, { chatId, provider })
      stored += 1
    } catch { /* ignore */ }
  }
  return { stored, facts }
}
