import fs from 'fs'
let code = fs.readFileSync('src/components/MessageList.jsx', 'utf8')
code = code.replace(
  "{!isUser && m.tokens?.total ? (",
  `{!isUser && isDev && hasAgentActivity && (
            <button
              onClick={() => {
                const trace = {
                  id: m.id,
                  role: 'assistant',
                  content: m.content,
                  agentContext: m.agentContext,
                  agentState: m.agentState,
                  tools: m.toolCalls,
                  thoughts: m.thoughts,
                  askUsers: m.askUsers,
                  error: m.error,
                  providerError: m.providerError,
                  warnings: m.routerWarnings,
                  tokens: m.tokens
                }
                const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = \`agent-trace-\${m.id}.json\`
                a.click()
                URL.revokeObjectURL(url)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-cream-faint hover:text-cream px-1"
              title="Export Agent Trace JSON"
            >
              {"{}"}
            </button>
          )}
          {!isUser && m.tokens?.total ? (`
)
fs.writeFileSync('src/components/MessageList.jsx', code)
