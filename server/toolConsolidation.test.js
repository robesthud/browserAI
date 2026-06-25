import { describe, expect, it } from 'vitest'
import {
  expandConsolidatedCall,
  isConsolidatedTool,
  CONSOLIDATED_TOOL_NAMES,
  renderConsolidatedTools,
  buildConsolidatedNativeSpec,
} from './toolConsolidation.js'
import { TOOLS } from './agentTools.js'

/**
 * Approach 2 — Runtime Unification. Tests for the consolidated↔legacy
 * expansion layer (`expandConsolidatedCall`) and registry consistency.
 *
 * These tests verify:
 *   1. Every consolidated tool name + action expands to a valid
 *      underlying tool that exists in TOOLS (no dangling references).
 *   2. Missing/empty action returns a graceful error.
 *   3. Unknown action returns a graceful error.
 *   4. Unknown consolidated tool name passes through unchanged (legacy).
 *   5. CONSOLIDATED_TOOL_NAMES contains every group name + standalone.
 *   6. buildConsolidatedNativeSpec generates valid OpenAI tool schema.
 *   7. renderConsolidatedTools produces human-readable text.
 */
describe('toolConsolidation: expandConsolidatedCall (input→output)', () => {
  it('file(action:read) → read_file', () => {
    const r = expandConsolidatedCall('file', { action: 'read', path: 'src/app.js' })
    expect(r.error).toBeUndefined()
    expect(r.name).toBe('read_file')
    expect(r.args.path).toBe('src/app.js')
    expect(r.args.action).toBeUndefined()  // action stripped
  })

  it('file(action:write) → write_file', () => {
    const r = expandConsolidatedCall('file', { action: 'write', path: 'a.js', content: 'x' })
    expect(r.name).toBe('write_file')
    expect(r.args.path).toBe('a.js')
    expect(r.args.content).toBe('x')
  })

  it('file(action:edit) → edit_file', () => {
    const r = expandConsolidatedCall('file', { action: 'edit', path: 'a.js', old_text: 'a', new_text: 'b' })
    expect(r.name).toBe('edit_file')
    expect(r.args.old_text).toBe('a')
  })

  it('file(action:list) → list_files', () => {
    const r = expandConsolidatedCall('file', { action: 'list' })
    expect(r.name).toBe('list_files')
  })

  it('file(action:search) → search_files', () => {
    const r = expandConsolidatedCall('file', { action: 'search', query: 'foo' })
    expect(r.name).toBe('search_files')
    expect(r.args.query).toBe('foo')
  })

  it('file(action:snapshot_create) → workspace_snapshot_create', () => {
    const r = expandConsolidatedCall('file', { action: 'snapshot_create' })
    expect(r.name).toBe('workspace_snapshot_create')
  })

  it('shell(action:run) → bash', () => {
    const r = expandConsolidatedCall('shell', { action: 'run', command: 'ls -la' })
    expect(r.name).toBe('bash')
    expect(r.args.command).toBe('ls -la')
  })

  it('shell(action:background_start) → shell_background_start', () => {
    const r = expandConsolidatedCall('shell', { action: 'background_start', command: 'npm run dev', name: 'dev-server' })
    expect(r.name).toBe('shell_background_start')
    expect(r.args.name).toBe('dev-server')
  })

  it('git(action:commit) → git_commit', () => {
    const r = expandConsolidatedCall('git', { action: 'commit', message: 'fix bug' })
    expect(r.name).toBe('git_commit')
    expect(r.args.message).toBe('fix bug')
  })

  it('git(action:status) → git_status', () => {
    const r = expandConsolidatedCall('git', { action: 'status' })
    expect(r.name).toBe('git_status')
  })

  it('web(action:search) → web_search', () => {
    const r = expandConsolidatedCall('web', { action: 'search', query: 'BrowserAI', limit: 5 })
    expect(r.name).toBe('web_search')
    expect(r.args.limit).toBe(5)
  })

  it('web(action:fetch) → web_fetch', () => {
    const r = expandConsolidatedCall('web', { action: 'fetch', url: 'https://example.com' })
    expect(r.name).toBe('web_fetch')
  })

  it('browser(action:open) → browser_open', () => {
    const r = expandConsolidatedCall('browser', { action: 'open', url: 'https://example.com' })
    expect(r.name).toBe('browser_open')
  })

  it('browser(action:screenshot) → browser_screenshot', () => {
    const r = expandConsolidatedCall('browser', { action: 'screenshot' })
    expect(r.name).toBe('browser_screenshot')
  })

  it('kb(action:add) → kb_add', () => {
    const r = expandConsolidatedCall('kb', { action: 'add', title: 'note', text: 'body' })
    expect(r.name).toBe('kb_add')
  })

  it('docker(action:ps) → docker_ps', () => {
    const r = expandConsolidatedCall('docker', { action: 'ps' })
    expect(r.name).toBe('docker_ps')
  })

  it('docker(action:logs) → docker_logs', () => {
    const r = expandConsolidatedCall('docker', { action: 'logs', container: 'web' })
    expect(r.name).toBe('docker_logs')
  })

  it('ops(action:run) → ops_run_action', () => {
    const r = expandConsolidatedCall('ops', { action: 'run', service: 'web', op: 'restart' })
    expect(r.name).toBe('ops_run_action')
  })

  it('ops(action:list) → ops_list_services', () => {
    const r = expandConsolidatedCall('ops', { action: 'list' })
    expect(r.name).toBe('ops_list_services')
  })

  it('memory(action:remember) → remember_fact', () => {
    const r = expandConsolidatedCall('memory', { action: 'remember', key: 'k', value: 'v' })
    expect(r.name).toBe('remember_fact')
  })

  it('media(action:generate_image) → generate_image', () => {
    const r = expandConsolidatedCall('media', { action: 'generate_image', prompt: 'cat' })
    expect(r.name).toBe('generate_image')
  })
})

describe('toolConsolidation: graceful error handling', () => {
  it('returns error when action is missing', () => {
    const r = expandConsolidatedCall('file', { path: 'a.js' })
    expect(r.error).toMatch(/requires an "action" parameter/)
    expect(r.name).toBeUndefined()
  })

  it('returns error when action is unknown', () => {
    const r = expandConsolidatedCall('file', { action: 'this-action-does-not-exist' })
    expect(r.error).toMatch(/Unknown action/)
    expect(r.name).toBeUndefined()
  })

  it('returns error when action is empty string', () => {
    const r = expandConsolidatedCall('file', { action: '' })
    expect(r.error).toMatch(/requires an "action" parameter/)
  })

  it('passes through legacy tool names unchanged', () => {
    // write_file is a LEGACY name — should NOT be expanded.
    const r = expandConsolidatedCall('write_file', { path: 'a.js', content: 'x' })
    expect(r.error).toBeUndefined()
    expect(r.name).toBe('write_file')
    expect(r.args.path).toBe('a.js')
  })

  it('passes through unknown tool names unchanged', () => {
    const r = expandConsolidatedCall('weird_unregistered_tool', { foo: 'bar' })
    expect(r.error).toBeUndefined()
    expect(r.name).toBe('weird_unregistered_tool')
    expect(r.args.foo).toBe('bar')
  })

  it('handles undefined args gracefully', () => {
    const r = expandConsolidatedCall('file')
    expect(r.error).toMatch(/requires an "action"/)
  })

  it('handles null args gracefully', () => {
    const r = expandConsolidatedCall('file', null)
    expect(r.error).toMatch(/requires an "action"/)
  })
})

describe('toolConsolidation: registry consistency', () => {
  it('isConsolidatedTool returns true for all group names', () => {
    for (const name of ['file', 'shell', 'git', 'web', 'browser', 'computer', 'media', 'memory', 'kb', 'verify', 'plan', 'docker', 'ops', 'operator']) {
      expect(isConsolidatedTool(name)).toBe(true)
    }
  })

  it('isConsolidatedTool returns false for legacy names', () => {
    for (const name of ['write_file', 'read_file', 'bash', 'git_commit', 'web_search', 'browser_open']) {
      expect(isConsolidatedTool(name)).toBe(false)
    }
  })

  it('isConsolidatedTool returns true for STANDALONE tools', () => {
    for (const name of ['ask_user', 'read_project_rules', 'project_profile', 'db_query', 'review_code_changes', 'generate_video', 'debug_run_code']) {
      expect(isConsolidatedTool(name)).toBe(true)
    }
  })

  it('CONSOLIDATED_TOOL_NAMES contains exactly the group names + standalone names', () => {
    // 14 groups + 7 standalones = 21.
    expect(CONSOLIDATED_TOOL_NAMES.length).toBe(21)
  })

  it('every underlying name in GROUPS exists in TOOLS (no dangling references)', () => {
    // Iterate every (group, action, underlying) tuple from the expansion output
    // and verify TOOLS[underlying] is defined.
    const groups = ['file', 'shell', 'git', 'web', 'browser', 'computer', 'media', 'memory', 'kb', 'verify', 'plan', 'docker', 'ops', 'operator']
    for (const g of groups) {
      // Try common actions per group.
      const actions = ['list', 'read', 'write', 'edit', 'delete', 'search', 'create_folder', 'rename', 'zip',
                       'snapshot_create', 'snapshot_list', 'snapshot_restore',
                       'run', 'background_start', 'background_read', 'background_stop', 'background_list', 'reset',
                       'status', 'clone', 'commit', 'fetch', 'open', 'screenshot', 'click', 'type', 'close',
                       'open_app', 'generate_image', 'edit_image', 'analyze_image', 'tts', 'transcribe',
                       'remember', 'recall', 'forget', 'add', 'ps', 'logs']
      for (const a of actions) {
        const r = expandConsolidatedCall(g, { action: a })
        if (r.name) {
          // We got an expansion. Verify TOOLS has the underlying handler.
          expect(TOOLS[r.name], `${g}(action:${a}) → ${r.name} must exist in TOOLS`).toBeDefined()
          expect(typeof TOOLS[r.name].handler).toBe('function')
        }
      }
    }
  })
})

describe('toolConsolidation: buildConsolidatedNativeSpec', () => {
  it('returns OpenAI-style function specs for native tools', () => {
    const specs = buildConsolidatedNativeSpec()
    expect(Array.isArray(specs)).toBe(true)
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
      expect(spec.type).toBe('function')
      expect(spec.function).toBeDefined()
      expect(spec.function.name).toBeTypeOf('string')
      expect(spec.function.description).toBeTypeOf('string')
      expect(spec.function.parameters).toBeDefined()
      expect(spec.function.parameters.required).toContain('action')
      expect(Array.isArray(spec.function.parameters.properties.action.enum)).toBe(true)
    }
  })

  it('each spec.action enum contains only valid actions for that tool', () => {
    const specs = buildConsolidatedNativeSpec()
    for (const spec of specs) {
      const toolName = spec.function.name
      for (const action of spec.function.parameters.properties.action.enum) {
        const r = expandConsolidatedCall(toolName, { action })
        expect(r.error, `${toolName}(action:${action}) should expand without error`).toBeUndefined()
        expect(r.name).toBeTypeOf('string')
      }
    }
  })
})

describe('toolConsolidation: renderConsolidatedTools', () => {
  it('produces a non-empty string with tool names', () => {
    const text = renderConsolidatedTools()
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(100)
    // Every group name should appear.
    for (const g of ['file', 'shell', 'git', 'web', 'browser', 'docker', 'ops']) {
      expect(text, `renderConsolidatedTools should mention ${g}`).toContain(g)
    }
  })
})
