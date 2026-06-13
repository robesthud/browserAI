import { describe, expect, it } from 'vitest'
import { generateProjectRunbook, inferCommands } from '../server/operatorProjectOnboarding.js'

describe('operator project onboarding', () => {
  it('infers package manager commands from project profile', () => {
    const npm = inferCommands({ profile: { packageJson: 'package.json', packageManager: 'npm', lockfiles: ['package-lock.json'], scripts: { test: 'vitest', build: 'vite build', lint: 'eslint .' } } })
    expect(npm.install).toContain('npm ci')
    expect(npm.test).toBe('npm test')
    expect(npm.build).toBe('npm run build')
    const pnpm = inferCommands({ profile: { packageJson: 'package.json', packageManager: 'pnpm', lockfiles: ['pnpm-lock.yaml'], scripts: { test: 'vitest' } } })
    expect(pnpm.install).toContain('pnpm install')
    expect(pnpm.test).toBe('pnpm test')
  })

  it('generates project-specific runbook markdown', () => {
    const md = generateProjectRunbook({ project: { id: 'x', name: 'X', repo: 'owner/x', localPath: '/workspace/projects/x', productionPath: '/srv/x' }, profile: { stack: ['react'], packageManager: 'npm', root: '.', entrypoints: ['src/main.jsx'] }, commands: { test: 'npm test', build: 'npm run build' } })
    expect(md).toContain('X Runbook')
    expect(md).toContain('owner/x')
    expect(md).toContain('npm test')
  })
})
