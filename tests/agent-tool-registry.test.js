import { describe, expect, it } from 'vitest'
import { TOOLS, renderToolsForPrompt } from '../server/agentTools.js'
import { buildClineSystemPrompt } from '../server/clinePrompt.js'

describe('agent tool registry and prompt', () => {
  it('exposes planning, user question and memory tools used by the agent loop', () => {
    for (const name of ['plan_set', 'plan_check', 'ask_user', 'recall_facts', 'remember_fact', 'kb_search', 'kb_list', 'read_project_rules', 'project_profile', 'npm_test', 'verify_task', 'secret_scan', 'workspace_snapshot_create', 'workspace_snapshot_restore', 'git_clone', 'zip_files', 'create_folder', 'rename_item', 'operator_status', 'operator_start_mission', 'operator_project_profile']) {
      expect(TOOLS[name]).toBeTruthy()
    }
  })

  it('filters the prompt catalog to the active profile tools', () => {
    const prompt = renderToolsForPrompt(null, { toolNames: ['read_file', 'npm_test'] })
    expect(prompt).toContain('### read_file')
    expect(prompt).toContain('### npm_test')
    expect(prompt).not.toContain('### write_file')
  })

  it('does not instruct models to use removed tool names', () => {
    const prompt = buildClineSystemPrompt({ toolNames: ['read_project_rules', 'list_files', 'read_file', 'search_files', 'npm_test', 'verify_code'] })
    for (const removed of ['build_repo_map', 'run_tests', 'git_diff', 'git_push', 'replace_across_files', 'save_lesson', 'find_projects', 'download_url', 'fetch_page']) {
      expect(prompt).not.toContain(removed)
    }
  })
})
