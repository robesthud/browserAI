import { describe, expect, it } from 'vitest'
import { bestRuntimeAdapter, buildAdapterRunbook, matchRuntimeAdapters } from '../server/operatorRuntimeAdapters.js'

describe('operator runtime adapters', () => {
  it('matches node/react and generates adapter runbook', () => {
    const profile = { stack: ['react', 'vite'], packageManager: 'npm', packageJson: 'package.json', lockfiles: ['package-lock.json'] }
    const best = bestRuntimeAdapter({ profile, template: { id: 'node-vite-react' } })
    expect(best.id).toBe('node')
    const all = matchRuntimeAdapters({ profile, template: { id: 'node-vite-react' } })
    expect(all.length).toBeGreaterThan(0)
    const md = buildAdapterRunbook({ adapter: best, project: { name: 'X' }, profile, commands: { test: 'npm test', build: 'npm run build' } })
    expect(md).toContain('Node.js')
    expect(md).toContain('npm test')
  })

  it('matches python/go/rust/docker/static signatures', () => {
    expect(bestRuntimeAdapter({ profile: {}, template: { id: 'python-api' } })?.id).toBe('python')
    expect(bestRuntimeAdapter({ profile: {}, template: { id: 'go-service' } })?.id).toBe('go')
    expect(bestRuntimeAdapter({ profile: {}, template: { id: 'rust-service' } })?.id).toBe('rust')
    expect(bestRuntimeAdapter({ profile: { stack: ['docker-compose'] }, template: null })?.id).toBe('docker')
    expect(bestRuntimeAdapter({ profile: {}, template: { id: 'static-site' } })?.id).toBe('static')
  })
})
