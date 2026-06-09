import fs from 'fs'
let code = fs.readFileSync('src/components/AgentRuntimePanel.jsx', 'utf8')

code = code.replace(
  "const [open, setOpen] = useState(true)",
  "const isRunning = state.status === 'running' || state.status === 'planning'\n  const [open, setOpen] = useState(isRunning)"
)

// The second isRunning is already there, let's remove the duplicated declaration:
code = code.replace(
  "const isRunning = state.status === 'running' || state.status === 'planning'\n\n  return (",
  "return ("
)

fs.writeFileSync('src/components/AgentRuntimePanel.jsx', code)
