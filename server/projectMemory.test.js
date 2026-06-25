import { describe, it, expect, beforeEach } from 'vitest'
import {
  upsertProjectFact, listProjectFacts, forgetProjectFact,
  renderProjectMemoryForPrompt,
} from './projectMemory.js'

const UID = 'test-user-pm'
const CID = 'test-chat-pm'

describe('projectMemory', () => {
  it('upserts and lists facts', () => {
    upsertProjectFact(UID, CID, 'stack', 'Node.js + React')
    upsertProjectFact(UID, CID, 'server', '186.246.31.78')
    const facts = listProjectFacts(UID, CID)
    expect(facts.length).toBeGreaterThanOrEqual(2)
    expect(facts.some(f => f.key === 'stack')).toBe(true)
    expect(facts.some(f => f.key === 'server')).toBe(true)
  })

  it('upsert overwrites existing key', () => {
    upsertProjectFact(UID, CID, 'stack', 'original')
    upsertProjectFact(UID, CID, 'stack', 'updated')
    const facts = listProjectFacts(UID, CID)
    const stackFacts = facts.filter(f => f.key === 'stack')
    expect(stackFacts.length).toBe(1)
    expect(stackFacts[0].value).toBe('updated')  // value stored as-is (only key is lowercased)
  })

  it('forgets a fact', () => {
    upsertProjectFact(UID, CID, 'temp_key', 'temp_value')
    const before = listProjectFacts(UID, CID).find(f => f.key === 'temp_key')
    expect(before).toBeTruthy()
    forgetProjectFact(UID, CID, 'temp_key')
    const after = listProjectFacts(UID, CID).find(f => f.key === 'temp_key')
    expect(after).toBeUndefined()
  })

  it('renders prompt block', () => {
    upsertProjectFact(UID, CID, 'deploy_cmd', 'docker compose up -d')
    const prompt = renderProjectMemoryForPrompt(UID, CID)
    expect(prompt).toContain('Project context')
    expect(prompt).toContain('deploy_cmd')
    expect(prompt).toContain('docker compose up -d')
  })

  it('returns empty string when no facts', () => {
    const prompt = renderProjectMemoryForPrompt('no-user', 'no-chat')
    expect(prompt).toBe('')
  })

  it('sanitizes chatId in forgetProjectFact — path traversal', () => {
    upsertProjectFact(UID, CID, 'safe_key', 'safe_value')
    // Malicious chatId should not delete from legitimate chat
    const result = forgetProjectFact(UID, '../../../etc', 'safe_key')
    expect(result.deleted).toBe(0)
    const fact = listProjectFacts(UID, CID).find(f => f.key === 'safe_key')
    expect(fact).toBeTruthy()
  })

  it('requires userId and chatId', () => {
    expect(upsertProjectFact('', CID, 'k', 'v')).toBeNull()
    expect(upsertProjectFact(UID, '', 'k', 'v')).toBeNull()
    expect(listProjectFacts('', CID)).toEqual([])
    expect(listProjectFacts(UID, '')).toEqual([])
    expect(forgetProjectFact('', CID, 'k').deleted).toBe(0)
  })

  it('truncates value at 600 chars', () => {
    const long = 'x'.repeat(700)
    upsertProjectFact(UID, CID, 'long_val', long)
    const fact = listProjectFacts(UID, CID).find(f => f.key === 'long_val')
    expect(fact.value.length).toBeLessThanOrEqual(600)
  })
})
