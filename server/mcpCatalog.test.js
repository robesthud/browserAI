import { describe, it, expect } from 'vitest'
import { MCP_CATALOG, MCP_CATEGORIES, getCatalogServer } from './mcpCatalog.js'

describe('mcpCatalog', () => {
  it('has servers', () => {
    expect(Array.isArray(MCP_CATALOG)).toBe(true)
    expect(MCP_CATALOG.length).toBeGreaterThan(5)
  })

  it('every server has required fields', () => {
    for (const s of MCP_CATALOG) {
      expect(typeof s.id).toBe('string')
      expect(s.id.length).toBeGreaterThan(0)
      expect(typeof s.name).toBe('string')
      expect(typeof s.category).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(s.install).toBeTruthy()
      expect(typeof s.install.command).toBe('string')
      expect(Array.isArray(s.install.args)).toBe(true)
      expect(typeof s.envVars).toBe('object')
    }
  })

  it('getCatalogServer returns correct server', () => {
    const github = getCatalogServer('github')
    expect(github).toBeTruthy()
    expect(github.id).toBe('github')
    expect(github.name).toBe('GitHub')
  })

  it('getCatalogServer returns null for unknown', () => {
    expect(getCatalogServer('nonexistent_xyz')).toBeNull()
    expect(getCatalogServer('')).toBeNull()
  })

  it('has expected categories', () => {
    const cats = new Set(MCP_CATALOG.map(s => s.category))
    expect(cats.has('dev')).toBe(true)
    expect(cats.has('productivity')).toBe(true)
    expect(cats.has('database')).toBe(true)
  })

  it('MCP_CATEGORIES contains all', () => {
    const all = MCP_CATEGORIES.find(c => c.id === 'all')
    expect(all).toBeTruthy()
  })

  it('no duplicate ids', () => {
    const ids = MCP_CATALOG.map(s => s.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('envVars placeholders are non-empty strings', () => {
    for (const s of MCP_CATALOG) {
      for (const [key, meta] of Object.entries(s.envVars || {})) {
        expect(typeof meta.label).toBe('string')
        expect(meta.label.length).toBeGreaterThan(0)
      }
    }
  })
})
