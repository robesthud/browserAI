/**
 * evidenceStatus.js
 *
 * Pure logic for classifying a finalStatus into one of:
 *   { tone: 'success' | 'partial' | 'blocked' | 'interrupted' | 'unknown', label, glyph }
 *
 * Lives outside AgentEvidenceBlock.jsx so it can be unit-tested without
 * React rendering machinery (jsdom / happy-dom not required).
 */

export function classifyEvidenceStatus(finalStatus = {}) {
  const fs = finalStatus || {}
  if (Array.isArray(fs.blockers) && fs.blockers.length > 0) return { tone: 'blocked', label: 'Blocked', glyph: '🔴' }
  if (fs.taskCompleted && fs.verified && (!fs.deploy?.requested || (fs.deploy?.done && fs.deploy?.verified))) {
    return { tone: 'success', label: 'Completed', glyph: '✓' }
  }
  if (fs.taskCompleted) return { tone: 'partial', label: 'Partial', glyph: '⚠' }
  if (['crash', 'llm-error', 'cap-reached'].includes(fs.reason)) return { tone: 'interrupted', label: 'Interrupted', glyph: '⏸' }
  return { tone: 'unknown', label: 'No status', glyph: '?' }
}

export function summarizeEvidence(fs = {}, summary = null) {
  const ss = summary || fs.evidenceSummary || {}
  return {
    filesRead: ss.filesRead || 0,
    filesChanged: ss.filesChanged || 0,
    commandsRun: ss.commandsRun || 0,
    testsRun: ss.testsRun || 0,
    testsPassed: ss.testsPassed || 0,
    errors: ss.errors || 0,
    totalSteps: ss.totalSteps || 0,
  }
}

export default { classifyEvidenceStatus, summarizeEvidence }
