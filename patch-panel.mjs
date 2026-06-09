import fs from 'fs'
let code = fs.readFileSync('src/components/AgentRuntimePanel.jsx', 'utf8')

code = code.replace(
  "export default function AgentRuntimePanel({ context, state, aiWorking }) {\n  if (!state) return null\n\n  const isRunning = state.status === 'running' || state.status === 'planning'\n  const [open, setOpen] = useState(isRunning)",
  "export default function AgentRuntimePanel({ context, state, aiWorking }) {\n  const isRunning = state?.status === 'running' || state?.status === 'planning'\n  const [open, setOpen] = useState(isRunning)\n\n  if (!state) return null"
)

fs.writeFileSync('src/components/AgentRuntimePanel.jsx', code)
