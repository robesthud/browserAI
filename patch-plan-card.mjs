import fs from 'fs'
let code = fs.readFileSync('src/components/AgentPlanCard.jsx', 'utf8')
code = code.replace(
  "export default function AgentPlanCard({ plan }) {",
  "export default function AgentPlanCard({ plan, hideBorder = false }) {"
)
code = code.replace(
  'className="my-2 overflow-hidden rounded-xl border border-white/10 bg-graphite-800/45 p-3 text-[13px]"',
  'className={`overflow-hidden text-[13px] ${hideBorder ? "" : "my-2 rounded-xl border border-white/10 bg-graphite-800/45 p-3"}`}'
)
fs.writeFileSync('src/components/AgentPlanCard.jsx', code)
