/**
 * agentTurnOrchestrator.js
 *
 * One-turn runtime orchestration layer: model reply → decision → policy →
 * executable action, pushback, or final draft. This mirrors Arena-style agent
 * architecture more closely than scattering decision gates through agentLoop.
 */

import { extractAgentDecision } from './agentDecision.js'
import {
  finalRejectionForNoAction,
  shouldExecuteTextShellCommand,
} from './agentActionPolicy.js'

const DEFAULT_MAX_PUSHBACKS = 2

export function looksLikeUnappliedCodeReply(text = '', history = []) {
  const reply = String(text || '')
  if (!/```[a-z0-9_+-]*\n[\s\S]{120,}?\n```/i.test(reply)) return false
  const lastUser = [...history].reverse().find((m) => m?.role === 'user')
  const askText = String(lastUser?.content || '')
  return /(созда|напиши|сделай|реализуй|исправ|поправ|почини|refactor|fix|create|new)/i.test(askText)
}

function asFinalDecision(reply = {}, source = 'assistant_text') {
  return { type: 'final', text: String(reply?.text || ''), source }
}

export function resolveAgentTurn({
  reply = {},
  useNativeTools = false,
  correctToolName = (n) => n,
  toolExists = () => true,
  agentContext = {},
  recentToolHistory = [],
  history = [],
  noToolsPushbackCount = 0,
  unappliedCodePushbackCount = 0,
  maxPushbacks = DEFAULT_MAX_PUSHBACKS,
  pushedBackThisTurn = false,
  aborted = false,
} = {}) {
  let decision = extractAgentDecision({ reply, useNativeTools, correctToolName, toolExists })
  let calls = decision.type === 'tool_calls' ? [...decision.calls] : []

  // A markdown/inline shell command in model text is treated as a real action
  // proposal. But if it is only quoted in an evidence-backed final report after
  // real work, keep it as final text and do not rerun it.
  if (decision.source === 'markdown_shell' && calls.length > 0) {
    const command = calls[0]?.args?.command || ''
    if (!shouldExecuteTextShellCommand({ command, draftText: reply.text || '', recentToolHistory })) {
      decision = asFinalDecision(reply, 'assistant_text_with_quoted_shell')
      calls = []
    }
  }

  if (calls.length > 0) {
    return { kind: 'tool_calls', decision, calls, source: decision.source }
  }

  const finalDecision = decision.type === 'final' ? decision : asFinalDecision(reply, 'invalid_as_final')
  const rejection = finalRejectionForNoAction({
    decision: finalDecision,
    agentContext,
    recentToolHistory,
    pushbackCount: noToolsPushbackCount,
    maxPushbacks,
  })
  if (rejection && !pushedBackThisTurn && !aborted) {
    return { kind: 'pushback', code: rejection.code, thought: rejection.thought, userPrompt: rejection.userPrompt, decision: finalDecision }
  }

  if (
    looksLikeUnappliedCodeReply(reply.text, history) &&
    !aborted &&
    !pushedBackThisTurn &&
    unappliedCodePushbackCount < maxPushbacks
  ) {
    return {
      kind: 'pushback',
      code: 'unapplied_code',
      thought: 'Применяю изменения через инструмент, чтобы они реально попали в файлы.',
      userPrompt: 'You provided code without tool calls. Apply changes with write_file/edit_file or one shell action now. Do not final-answer until the file is actually changed.',
      decision: finalDecision,
    }
  }

  return { kind: 'final', decision: finalDecision, text: finalDecision.text, source: finalDecision.source }
}

export const __test = {
  asFinalDecision,
  DEFAULT_MAX_PUSHBACKS,
}
