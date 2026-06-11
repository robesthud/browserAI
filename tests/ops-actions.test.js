import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { listOpsServices } from '../server/ops.js'

describe('ops action catalog', () => {
  it('treats workflow display names and workflow files differently in source', () => {
    const source = String(readFileSync(new URL('../server/ops.js', import.meta.url), 'utf8'))
    expect(source).toContain('workflowLooksLikeIdOrFile')
    expect(source).toContain('NOT the display name')
  })

  it('exposes CI/deploy wait helpers to agents', () => {
    const services = listOpsServices()
    const github = services.find((s) => s.id === 'github')
    const browserai = services.find((s) => s.id === 'browserai')
    expect(github?.actions.map((a) => a.action)).toContain('actions_status')
    expect(github?.actions.map((a) => a.action)).toContain('actions_wait')
    expect(browserai?.actions.map((a) => a.action)).toContain('app_health_check')
    expect(browserai?.actions.map((a) => a.action)).toContain('deploy_wait')
    expect(browserai?.actions.map((a) => a.action)).toContain('docker_logs_recent')
  })
})
