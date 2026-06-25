/**
 * toolConsolidation.js
 *
 * Слой консолидации: показывает модели ~15 объединённых инструментов вместо 90+.
 * Все существующие обработчики (TOOLS в agentTools.js) остаются нетронутыми —
 * этот модуль только переформатирует ТО, что видит модель, и диспетчеризует вызовы.
 *
 * Принцип:
 *   file(action: "read", path: "src/app.js")
 *   → expandConsolidatedCall("file", {action:"read", path:"src/app.js"})
 *   → { name: "read_file", args: {path:"src/app.js"} }
 *   → TOOLS.read_file.handler({path:"src/app.js", _chatId, _signal, ...})
 *
 * Обратная совместимость: старые tool names (read_file, git_status, ...) работают
 * как прежде — expandConsolidatedCall() пропускает их без изменений.
 */

// ── Карта: consolidated → underlying ────────────────────────────────────────
// Каждая запись: { action: underlyingToolName }
const GROUPS = {
  file: {
    description: `File & workspace operations for simple one-off file actions. For multi-step inspect/read/write/verify workflows, prefer shell action:"run" so the chat shows one compact command instead of many tiny file tools. Use file actions when you need fuzzy edit, snapshots, zip, upload/download, binary/media files, or a single exact read/write.
Actions:
- list [path?] [show_hidden?] — list files/folders as a tree
- read <path> — read a text file's full contents
- write <path> <content> — create or fully overwrite a file
- edit <path> <old_text> <new_text> — replace a substring/block in an existing file
- delete <path> — delete a file or folder
- search <query> — grep file contents, returns matches with line numbers
- create_folder <path> — create a new folder
- rename <path> <new_name> — rename a file or folder
- zip [source_path?] [output_path?] — create a ZIP archive
- snapshot_create — save a rollback snapshot of the workspace
- snapshot_list — list saved snapshots
- snapshot_restore <step> — restore workspace to a saved snapshot`,
    actions: {
      list: 'list_files',
      read: 'read_file',
      write: 'write_file',
      edit: 'edit_file',
      delete: 'delete_file',
      search: 'search_files',
      create_folder: 'create_folder',
      rename: 'rename_item',
      zip: 'zip_files',
      snapshot_create: 'workspace_snapshot_create',
      snapshot_list: 'workspace_snapshot_list',
      snapshot_restore: 'workspace_snapshot_restore',
    },
  },

  shell: {
    description: `Default for multi-step workspace work. Run shell commands in a persistent Linux sandbox. Use action:"run" to combine related inspect/read/write/verify commands in one call (find/grep/cat/python heredoc/npm test). cwd, env, cd, exported paths persist across calls. The sandbox has git, npm, node, python, docker, kubectl, terraform, ssh, curl, and more.
Actions:
- run <command> [timeout_sec?] — run a command (stateful per chat). Default timeout 60s.
- background_start <command> [name?] [cwd?] — start a long-running command in the background (dev servers, watchers, builds)
- background_read <task_id> — read output of a background command
- background_stop <task_id> — stop a background command
- background_list — list background commands
- reset — reset/kill the persistent shell session if it's stuck or polluted`,
    actions: {
      run: 'bash',
      background_start: 'shell_background_start',
      background_read: 'shell_background_read',
      background_stop: 'shell_background_stop',
      background_list: 'shell_background_list',
      reset: 'shell_session_reset',
    },
  },

  git: {
    description: `Git operations on the workspace repository.
Actions:
- status — check git status (what changed). Call before committing.
- clone <url> [dest?] — clone a repo into the workspace (fetches/pulls if it already exists)
- commit <message> — stage all, commit with a message, and push to origin. Uses conventional commit format.`,
    actions: {
      status: 'git_status',
      clone: 'git_clone',
      commit: 'git_commit',
    },
  },

  web: {
    description: `Web access: search the internet and fetch pages.
Actions:
- search <query> [limit?] — search the web for current information
- fetch <url> — download a web page as markdown`,
    actions: {
      search: 'web_search',
      fetch: 'web_fetch',
    },
  },

  browser: {
    description: `Browser automation: open pages, interact with elements, take screenshots. For scraping JS-heavy sites and web testing.
Actions:
- open <url> — open a page in the headless browser
- screenshot — take a screenshot of the current page
- click <selector> — click an element
- type <selector> <text> — type text into a field
- close — close the browser session`,
    actions: {
      open: 'browser_open',
      screenshot: 'browser_screenshot',
      click: 'browser_click',
      type: 'browser_type',
      close: 'browser_close',
    },
  },

  computer: {
    description: `Computer Use: control a virtual desktop (mouse, keyboard, apps). For GUI automation. Requires BROWSERAI_COMPUTER_USE=on.
Actions:
- screenshot — capture the desktop screen
- click <x> <y> — click at coordinates
- type <text> — type on the keyboard
- open_app <name> — open an application
- status — check if computer-use sandbox is reachable`,
    actions: {
      screenshot: 'computer_screenshot',
      click: 'computer_click',
      type: 'computer_type',
      open_app: 'computer_open_app',
      status: 'computer_status',
    },
  },

  media: {
    description: `Media generation & analysis. Uses Gemini/Vision models.
Actions:
- generate_image <prompt> [path?] — generate an image from a text prompt
- edit_image <prompt> <path> — edit an existing image
- analyze_image <path> [prompt?] — describe/analyze an image
- tts <text> — text to speech (audio)
- transcribe <path> — transcribe audio to text`,
    actions: {
      generate_image: 'generate_image',
      edit_image: 'edit_image',
      analyze_image: 'analyze_image',
      tts: 'text_to_speech',
      transcribe: 'transcribe_audio',
    },
  },

  memory: {
    description: `Long-term memory: facts that persist across all chats (preferences, project context, decisions).
Actions:
- remember <text> — store a memorable fact
- recall <query> — retrieve relevant stored facts
- forget <id> — delete a stored fact`,
    actions: {
      remember: 'remember_fact',
      recall: 'recall_facts',
      forget: 'forget_fact',
    },
  },

  kb: {
    description: `Knowledge base (RAG): store and search project documents for retrieval-augmented generation.
Actions:
- add <title> <content> — add a document
- search <query> [top_k?] — semantic search over documents
- list — list all documents
- delete <id> — delete a document`,
    actions: {
      add: 'kb_add',
      search: 'kb_search',
      list: 'kb_list',
      delete: 'kb_delete',
    },
  },

  verify: {
    description: `Code quality: verify, test, lint. Call verify action:"code" immediately after every write/edit to catch syntax errors.
Actions:
- code [path?] — verify code syntax (node --check, eslint, tsc). Auto-detects from file path.
- task — verify the current agent task's changes
- npm_test — run npm test
- npm_install — install npm dependencies
- secret_scan [root?] — scan for leaked secrets/passwords/API keys`,
    actions: {
      code: 'verify_code',
      task: 'verify_task',
      npm_test: 'npm_test',
      npm_install: 'npm_install',
      secret_scan: 'secret_scan',
    },
  },

  plan: {
    description: `Task planning: create and track a visible plan for complex multi-step tasks.
Actions:
- set <title> <steps> — create a plan with steps [{idx, title, detail?}]
- check <indices> — mark plan steps as done [0,1,2]`,
    actions: {
      set: 'plan_set',
      check: 'plan_check',
    },
  },

  docker: {
    description: `Docker container management on the host.
Actions:
- ps — list running containers
- logs <container> [lines?] — view container logs (useful for debugging crashes)`,
    actions: {
      ps: 'docker_ps',
      logs: 'docker_logs',
    },
  },

  ops: {
    description: `Operations: manage server services (deploy, restart, health checks).
Actions:
- list — list available ops services and actions
- run <service> <action> [params?] [confirm?] — run an ops action`,
    actions: {
      list: 'ops_list_services',
      run: 'ops_run_action',
    },
  },

  operator: {
    description: `Operator Mode: autonomous missions, CI/CD, project onboarding, failure recovery. For complex end-to-end engineering tasks.
Actions:
- status — operator control plane status (projects, missions, health)
- start_mission <goal> [type?] [project_id?] [confirm?] — start an autonomous mission (dev_task, full_diagnostic, safe_deploy, self_heal_restart, code_task...)
- get_mission <id> — get mission details
- list_missions — list recent missions
- analyze_project <repo> — onboard/analyze a GitHub repo for operator mode
- project_profile — list registered projects
- read_runbook <name> — read a project runbook (deploy.md, ci.md, lessons.md...)
- append_lesson <title> <body> — save a lesson learned
- classify_failure <error> — classify an error and recommend a fix
- execute_auto_fix <input> [confirm?] — execute a recommended auto-fix
- finalize_code_task <id> [commit_message?] — commit, push, create PR for a code task
- merge_code_task_pr <id> [merge_method?] — merge a code task's PR
- review_code_task <id> — review a code task's changes
- wait_code_task_ci <id> [timeout_sec?] — wait for CI to finish
- auto_fix_ci <id> [max_attempts?] — auto-fix a failing CI
- get_report <kind> <id> — get an operator report
- send_report <kind> <id> — send a report via Telegram`,
    actions: {
      status: 'operator_status',
      start_mission: 'operator_start_mission',
      get_mission: 'operator_get_mission',
      list_missions: 'operator_list_missions',
      analyze_project: 'operator_analyze_project',
      project_profile: 'operator_project_profile',
      list_templates: 'operator_list_project_templates',
      list_runtime_adapters: 'operator_list_runtime_adapters',
      list_runbooks: 'operator_list_runbooks',
      read_runbook: 'operator_read_runbook',
      update_runbook: 'operator_update_runbook',
      append_lesson: 'operator_append_lesson',
      classify_failure: 'operator_classify_failure',
      execute_auto_fix: 'operator_execute_auto_fix',
      get_super_workflow: 'operator_get_super_workflow',
      list_super_workflows: 'operator_list_super_workflows',
      finalize_code_task: 'operator_finalize_code_task',
      merge_code_task_pr: 'operator_merge_code_task_pr',
      review_code_task: 'operator_review_code_task',
      wait_code_task_ci: 'operator_wait_code_task_ci',
      auto_fix_ci: 'operator_auto_fix_code_task_ci',
      evaluate_project_policy: 'operator_evaluate_project_policy',
      get_report: 'operator_get_report',
      send_report: 'operator_send_report',
      list_github_automation_events: 'operator_list_github_automation_events',
      comment_github_issue: 'operator_comment_github_issue',
    },
  },
}

// Инструменты, которые остаются как есть (не объединяются).
// Их params/description уже компактны, либо они принципиально самостоятельны.
const TOOL_PRESENTATION_ORDER = ['shell', 'file', 'verify', 'git', 'web', 'browser', 'computer', 'media', 'plan', 'memory', 'kb', 'docker', 'ops', 'operator']

const STANDALONE_TOOLS = [
  'ask_user',
  'read_project_rules',
  'project_profile',
  'db_query',
  'review_code_changes',
  'generate_video',
  'debug_run_code',
]

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Развёрнутый список всех консолидированных имён инструментов.
 * Используется allowlist'ом, чтобы модель видела только объединённые имена.
 */
export const CONSOLIDATED_TOOL_NAMES = [...Object.keys(GROUPS), ...STANDALONE_TOOLS]

/**
 * Есть ли инструмент среди консолидированных групп?
 */
export function isConsolidatedTool(name) {
  // Approach 2 — a tool is 'consolidated' if it appears in either the
  // GROUP matrix (file/shell/git/etc.) or the STANDALONE_TOOLS list
  // (ask_user, read_project_rules, etc.). This must match
  // CONSOLIDATED_TOOL_NAMES — otherwise the allowlist will incorrectly
  // reject standalones as legacy.
  if (GROUPS[name]) return true
  if (STANDALONE_TOOLS.includes(name)) return true
  return false
}

/**
 * Развёрнуть вызов консолидированного инструмента в вызов базового.
 * Возвращает { name, args } для базового обработчика, либо { error } при ошибке вызова.
 *
 * Если name не является консолидированным — возвращает как есть (обратная совместимость
 * со старыми чатами, где модель вызывала read_file напрямую).
 */
export function expandConsolidatedCall(name, args) {
  // Approach 2 — defend against null/undefined args (defensive).
  // Without this, `String(args.action || '')` throws on null args.
  const safeArgs = (args && typeof args === 'object') ? args : {}
  const group = GROUPS[name]
  if (!group) {
    // Не консолидированный — пропускаем как есть (старый формат или standalone).
    return { name, args: safeArgs }
  }
  const action = String(safeArgs.action || '').trim()
  if (!action) {
    return { error: `Tool "${name}" requires an "action" parameter. Available actions: ${Object.keys(group.actions).join(', ')}.` }
  }
  const underlyingName = group.actions[action]
  if (!underlyingName) {
    return { error: `Unknown action "${action}" for tool "${name}". Available actions: ${Object.keys(group.actions).join(', ')}.` }
  }
  // Убираем action из args, остальное прокидываем как есть.
  const { action: _omit, ...rest } = args
  return { name: underlyingName, args: rest }
}

/**
 * Рендер описаний консолидированных инструментов для текстового промпта (XML/JSON протокол).
 * Заменяет renderToolsForPrompt() из agentTools.js.
 */
export function renderConsolidatedTools() {
  const lines = []
  for (const name of TOOL_PRESENTATION_ORDER.filter((n) => GROUPS[n])) {
    const def = GROUPS[name]
    lines.push(`### ${name}`)
    lines.push(def.description)
    lines.push('')
  }
  // Standalone — без описаний params, просто имена (они и так короткие).
  lines.push('### standalone')
  lines.push(`These tools are called directly with their own params: ${STANDALONE_TOOLS.join(', ')}.`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Сгенерировать OpenAI-style native function-calling схему для консолидированных
 * инструментов. Каждый инструмент получает параметр "action" (enum) + свободные args.
 *
 * Так как native function-calling требует жёсткой JSON-схемы, а consolidated-инструменты
 * принимают разные params в зависимости от action, мы используем "additionalProperties: true"
 * и перечисляем только action как обязательный. Текстовое описание (description) содержит
 * документацию по каждому action и его params.
 */
export function buildConsolidatedNativeSpec(extraTools = null) {
  const specs = []

  // Consolidated groups (file, shell, git, …)
  for (const name of TOOL_PRESENTATION_ORDER.filter((n) => GROUPS[n])) {
    const def = GROUPS[name]
    specs.push({
      type: 'function',
      function: {
        name,
        description: def.description,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'Which sub-action to perform. See the tool description for the full list and the params each one needs.',
              enum: Object.keys(def.actions),
            },
          },
          required: ['action'],
          additionalProperties: true,
        },
      },
    })
  }

  // Кастомные инструменты пользователя: добавляем в native spec как есть,
  // чтобы модель видела их при native function-calling.
  if (extraTools && typeof extraTools === 'object') {
    for (const [name, def] of Object.entries(extraTools)) {
      if (!def || typeof def !== 'object') continue
      const properties = {}
      const required = []
      for (const [pName, pMeta] of Object.entries(def.params || {})) {
        const schemaType = pMeta?.type === 'number' ? 'number'
          : pMeta?.type === 'boolean' ? 'boolean'
          : pMeta?.type === 'array' ? 'array'
          : pMeta?.type === 'object' ? 'object'
          : 'string'
        properties[pName] = { type: schemaType, description: pMeta?.description || '' }
        if (schemaType === 'array') properties[pName].items = { type: 'object' }
        if (schemaType === 'object') properties[pName].additionalProperties = true
        if (pMeta?.required) required.push(pName)
      }
      specs.push({
        type: 'function',
        function: {
          name,
          description: def.description || '',
          parameters: { type: 'object', properties, required },
        },
      })
    }
  }

  return specs
}

export default {
  GROUPS,
  STANDALONE_TOOLS,
  CONSOLIDATED_TOOL_NAMES,
  isConsolidatedTool,
  expandConsolidatedCall,
  renderConsolidatedTools,
  buildConsolidatedNativeSpec,
}
