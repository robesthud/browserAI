import fs from 'fs'
let code = fs.readFileSync('src/components/AgentAdmin.jsx', 'utf8')

code = code.replace(
  "if (plan) items.push(<AgentPlanCard key=\"plan\" plan={plan} />)",
  ""
)

fs.writeFileSync('src/components/AgentAdmin.jsx', code)
