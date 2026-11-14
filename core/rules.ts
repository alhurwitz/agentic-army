// Pure rules and budget accounting for an army tree. No I/O; every harness adapter shares these.
// Rules:
//   - depth of root = 0; children may go at most maxDepth levels below root (default 5, no upper cap; maxAgents bounds size)
//   - children must be army-officer or army-soldier; leaf level (depth == maxDepth) is soldier only
//   - the General (depth 0) spawns officers only unless maxDepth == 1
//   - a soldier that spawns is promoted to officer; it borrows the cost of each spawn from its parent
//   - an army member the adapter cannot identify may not spawn army children
//   - every commander has at most MAX_SPAN running or pending direct reports
//   - an officer spawn needs `TROOPS: <n>` as the prompt's first line; it costs the parent 1 + n,
//     a soldier costs 1; a finished officer returns its unused allotment to its parent
//   - every new child also counts against the global maxAgents cap; follow-ups do not
//   - non-army subagents (explore, general, ...) spawned by the General are not tracked or counted

export const DEFAULT_MAX_AGENTS = 50
export const DEFAULT_MAX_DEPTH = 5
export const MAX_SPAN = 5
export const OFFICER = "army-officer"
export const SOLDIER = "army-soldier"
const BUDGET_LINE = /^\s*TROOPS:\s*(\d+)\s*$/

export type Status = "running" | "done" | "failed" | "interrupted"
export type Node = {
  sessionID: string
  parentID: string
  agent: string
  description: string
  depth: number
  status: Status
  startedAt: number
  endedAt?: number
  budget: number
  used: number
  promoted?: boolean
}
// A spawn that passed validation but whose child id is not known yet.
export type Pending = {
  parentID: string
  child: string
  description: string
  depth: number
  budget: number
  cost: number
  at: number
  boundTo?: string
}
export type Army = {
  rootID: string
  harness?: string
  maxDepth: number
  maxAgents: number
  spawned: number
  officers: number
  ics: number
  used: number
  nodes: Record<string, Node>
  pending?: Record<string, Pending>
}
export type Located = { army?: Army; depth: number; agent?: string; node?: Node }

export const isArmyAgent = (agent: string) => agent === OFFICER || agent === SOLDIER

export const parseBudget = (prompt: string) => {
  const [first, ...rest] = prompt.split("\n")
  const match = BUDGET_LINE.exec(first ?? "")
  if (!match) return { budget: undefined, prompt }
  return { budget: Number(match[1]), prompt: rest.join("\n").replace(/^\n+/, "") }
}

export const remaining = (army: Army, node?: Node) => (node ? node.budget - node.used : army.maxAgents - army.used)

export const spawnCost = (child: string, budget = 0) => (child === OFFICER ? 1 + budget : 1)

export const newArmy = (rootID: string, maxDepth: number, maxAgents: number, harness?: string): Army => ({
  rootID,
  harness,
  maxDepth,
  maxAgents,
  spawned: 0,
  officers: 0,
  ics: 0,
  used: 0,
  nodes: {},
  pending: {},
})

// Shrinks a finished officer's allotment to what it used and returns the rest to its parent.
export const settle = (army: Army, node: Node) => {
  const unused = node.budget - node.used
  if (node.agent !== OFFICER || unused <= 0) return 0
  node.budget = node.used
  const parent = army.nodes[node.parentID]
  if (parent) parent.used -= unused
  else army.used -= unused
  return unused
}

export const validateShape = ({ army, agent, depth, node }: Located, child: string) => {
  if (!army) return isArmyAgent(child) ? `call army_mobilize before delegating to ${child}.` : undefined
  if (!isArmyAgent(child)) return depth === 0 ? undefined : `inside an army, delegate only to "${OFFICER}" or "${SOLDIER}" (got "${child}").`
  if (depth > 0 && !node) return `this session is not a tracked army member, so it cannot command troops. Do the work yourself or report to your officer.`
  if (depth + 1 > army.maxDepth) return `depth limit ${army.maxDepth} reached. Do this work yourself.`
  if (child === OFFICER && depth + 1 === army.maxDepth) return `depth ${depth + 1} is the soldier level (maxDepth ${army.maxDepth}); spawn "${SOLDIER}" instead.`
  if (child === SOLDIER && depth === 0 && army.maxDepth > 1) return `the General commands officers, not soldiers. Spawn "${OFFICER}" team leads; they command the soldiers.`
  if (agent !== undefined && agent !== OFFICER && agent !== SOLDIER && depth > 0) return `unknown army role "${agent}".`
  return undefined
}

export const directReports = (army: Army, parentID: string) =>
  Object.values(army.nodes).filter((n) => n.parentID === parentID && n.status === "running").length +
  Object.values(army.pending ?? {}).filter((p) => p.parentID === parentID && !p.boundTo).length

export const validateSpan = (army: Army, parentID: string) => {
  if (directReports(army, parentID) >= MAX_SPAN) return `span of control is ${MAX_SPAN} direct reports. Wait for one to finish (army_wait), or group the work under an "${OFFICER}".`
  return undefined
}

// A soldier (or a soldier already promoted) may borrow from its parent what its own budget lacks.
const shortfall = (army: Army, node: Node | undefined, cost: number) =>
  node && (node.agent === SOLDIER || node.promoted) ? Math.max(0, cost - remaining(army, node)) : 0

const parentOf = (army: Army, node: Node) => army.nodes[node.parentID]

export const validateBudget = (army: Army, node: Node | undefined, child: string, budget: number | undefined) => {
  if (child === OFFICER && budget === undefined) return `a ${OFFICER} prompt must start with the line "TROOPS: <n>" (agents its subtree may spawn).`
  const cost = spawnCost(child, budget)
  if (army.spawned >= army.maxAgents) return `global agent cap ${army.maxAgents} used up. Reuse existing children or do the work yourself.`
  const borrow = shortfall(army, node, cost)
  const available = node ? remaining(army, node) + (borrow ? remaining(army, parentOf(army, node)) : 0) : remaining(army)
  if (cost > available) return `spawning this ${child} costs ${cost} but your budget has ${available} left. Lower TROOPS, reuse children, or do the work yourself.`
  return undefined
}

// Promotes a spawning soldier to officer and moves any borrowed budget from its parent to it.
const promote = (army: Army, node: Node, cost: number) => {
  const borrow = shortfall(army, node, cost)
  if (node.agent === SOLDIER) {
    node.agent = OFFICER
    node.promoted = true
    army.ics--
    army.officers++
  }
  if (borrow === 0) return
  node.budget += borrow
  const parent = parentOf(army, node)
  if (parent) parent.used += borrow
  else army.used += borrow
}

export const charge = (army: Army, node: Node | undefined, child: string, cost: number) => {
  if (node) {
    promote(army, node, cost)
    node.used += cost
  } else army.used += cost
  army.spawned++
  if (child === OFFICER) army.officers++
  else army.ics++
}

export const refund = (army: Army, parentID: string, child: string, cost: number) => {
  const parent = army.nodes[parentID]
  if (parent) parent.used -= cost
  else army.used -= cost
  army.spawned--
  if (child === OFFICER) army.officers--
  else army.ics--
}

export const childPreamble = (army: Army, child: string, depth: number, budget: number) =>
  `[army] You are ${child} at depth ${depth}/${army.maxDepth}` +
  `${child === OFFICER ? `; your children may be ${depth + 1 === army.maxDepth ? `"${SOLDIER}" only` : `"${OFFICER}" or "${SOLDIER}"`}` : ""}. ` +
  `Budget left: ${budget}.\n\n`
