import { describe, expect, it } from 'vitest'
import { listOpsServices } from '../server/ops.js'

describe('ops action catalog', () => {
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
