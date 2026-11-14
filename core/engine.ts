// Harness-neutral army operations. Adapters (OpenCode plugin, hook command, MCP server) translate
// their events into these calls. Every mutation goes through withArmy, so separate processes agree.
import { execFileSync } from "node:child_process"

import { childrenOf, renderTree } from "../plugin/army-tui/tree.ts"
import {
  type Army,
  type Located,
  type Node,
  type Status,
  DEFAULT_MAX_AGENTS,
  DEFAULT_MAX_DEPTH,
  MAX_SPAN,
  OFFICER,
  SOLDIER,
  charge,
  childPreamble,
  isArmyAgent,
  newArmy,
  parseBudget,
  refund,
  remaining,
  settle,
  spawnCost,
  validateBudget,
  validateShape,
  validateSpan,
} from "./rules.ts"
import { listArmies, withArmy } from "./store.ts"

const PENDING_TTL_MS = 15 * 60_000
const WAIT_POLL_MS = 1_000

export type LocatedRoot = Located & { rootID?: string }

// chain = [caller, parent, grandparent, ...]. The first id that is a root or tracked node decides.
export const locate = (chain: string[]): LocatedRoot => {
  const armies = listArmies()
  for (let steps = 0; steps < chain.length; steps++) {
    const id = chain[steps]
    for (const army of armies) {
      if (army.rootID === id) return { army, rootID: army.rootID, depth: steps }
      const node = army.nodes[id]
      if (node) return steps === 0 ? { army, rootID: army.rootID, depth: node.depth, agent: node.agent, node } : { army, rootID: army.rootID, depth: node.depth + steps }
    }
  }
  return { depth: 0 }
}

const sweep = (army: Army, now = Date.now()) => {
  for (const [key, p] of Object.entries(army.pending ?? {})) {
    if (now - p.at < PENDING_TTL_MS) continue
    if (!p.boundTo) refund(army, p.parentID, p.child, p.cost)
    delete army.pending![key]
  }
}

export const mobilize = (callerChain: string[], input: { maxDepth?: number; maxAgents?: number }, harness?: string) => {
  const sessionID = callerChain[0]
  const { army: existing } = locate(callerChain)
  if (existing && existing.rootID !== sessionID) return `Not started: this session is already inside army ${existing.rootID}. Delegate within it.`
  const maxDepth = Math.max(1, Math.trunc(Number(input.maxDepth ?? DEFAULT_MAX_DEPTH)))
  const maxAgents = Math.max(1, Math.trunc(Number(input.maxAgents ?? DEFAULT_MAX_AGENTS)))
  const army = withArmy(sessionID, (saved) => {
    const army = saved ? Object.assign(saved, { maxDepth, maxAgents }) : newArmy(sessionID, maxDepth, maxAgents, harness)
    return { save: army, result: army }
  })
  return (
    `Army ${existing ? "updated" : "started"}: maxDepth=${maxDepth}, maxAgents=${maxAgents}, spawned=${army.spawned}. ` +
    `You are the General (depth 0): follow the army-officer playbook. ` +
    `Spawn "${maxDepth === 1 ? SOLDIER : OFFICER}" agents (max ${MAX_SPAN} direct reports per commander). ` +
    `An ${OFFICER} prompt must start with the line "TROOPS: <n>" (n = agents its subtree may spawn); it costs you 1 + n.`
  )
}

export type SpawnRequest = { chain: string[]; child: string; prompt: string; description: string; key: string }
export type SpawnDecision = { error?: string; prompt?: string }

// Validates and charges a spawn. Returns the rewritten prompt for army children, nothing for untracked spawns.
export const requestSpawn = ({ chain, child, prompt, description, key }: SpawnRequest): SpawnDecision => {
  const located = locate(chain)
  const shapeError = validateShape(located, child)
  if (shapeError) return { error: shapeError }
  if (!located.army || !isArmyAgent(child)) return {}
  const callerID = chain[0]
  return withArmy(located.rootID!, (army) => {
    if (!army) return { result: { error: "army state disappeared; call army_mobilize again." } }
    sweep(army)
    const node = located.node ? army.nodes[located.node.sessionID] : undefined
    const parsed = parseBudget(prompt)
    const error = validateSpan(army, callerID) ?? validateBudget(army, node, child, parsed.budget)
    if (error) return { result: { error } }
    const budget = child === OFFICER ? (parsed.budget ?? 0) : 0
    const cost = spawnCost(child, budget)
    const depth = located.depth + 1
    charge(army, node, child, cost)
    army.pending![key] = { parentID: callerID, child, description, depth, budget, cost, at: Date.now() }
    return { save: army, result: { prompt: childPreamble(army, child, depth, budget) + parsed.prompt } }
  })
}

const findPending = (key: string) => listArmies().find((army) => army.pending?.[key])

const placeNode = (army: Army, childID: string, p: { parentID: string; child: string; description: string; depth: number; budget: number }) => {
  const existing = army.nodes[childID]
  army.nodes[childID] = {
    sessionID: childID,
    parentID: p.parentID,
    agent: existing?.promoted ? existing.agent : p.child,
    description: p.description,
    depth: p.depth,
    status: existing?.status ?? "running",
    startedAt: existing?.startedAt ?? Date.now(),
    endedAt: existing?.endedAt,
    budget: existing?.budget ?? p.budget,
    used: existing?.used ?? 0,
    promoted: existing?.promoted,
  }
}

// Exact binding: the adapter knows which spawn produced which child.
export const bindSpawn = (key: string, childID: string) => {
  const owner = findPending(key)
  if (!owner) return
  withArmy(owner.rootID, (army) => {
    const p = army?.pending?.[key]
    if (!army || !p) return { result: undefined }
    placeNode(army, childID, p)
    delete army.pending![key]
    return { save: army, result: undefined }
  })
}

// Fallback binding when only the child's id and type are known (SubagentStart-style events):
// attach it to the oldest unbound spawn of that type in the caller's army.
export const bindByType = (chain: string[], childID: string, childType: string, parentHint?: string) => {
  if (!isArmyAgent(childType)) return
  const { rootID, army: current } = locate(chain)
  if (!rootID || current?.nodes[childID]) return
  withArmy(rootID, (army) => {
    if (!army || army.nodes[childID]) return { result: undefined }
    const open = Object.entries(army.pending ?? {})
      .filter(([, p]) => !p.boundTo && p.child === childType)
      .sort(([, a], [, b]) => a.at - b.at)
    const match = open.find(([, p]) => parentHint && p.parentID === parentHint) ?? open[0]
    if (!match) return { result: undefined }
    const [, p] = match
    placeNode(army, childID, p)
    p.boundTo = childID
    return { save: army, result: undefined }
  })
}

export const failSpawn = (key: string) => {
  const owner = findPending(key)
  if (!owner) return
  withArmy(owner.rootID, (army) => {
    const p = army?.pending?.[key]
    if (!army || !p) return { result: undefined }
    if (!p.boundTo) refund(army, p.parentID, p.child, p.cost)
    delete army.pending![key]
    return { save: army, result: undefined }
  })
}

export const ended = (childID: string, status: Status) => {
  const owner = listArmies().find((army) => army.nodes[childID])
  if (!owner) return
  withArmy(owner.rootID, (army) => {
    const node = army?.nodes[childID]
    if (!army || !node || node.status === status) return { result: undefined }
    node.status = status
    node.endedAt = status === "running" ? undefined : Date.now()
    if (status !== "running") settle(army, node)
    for (const [key, p] of Object.entries(army.pending ?? {})) if (p.boundTo === childID) delete army.pending![key]
    return { save: army, result: undefined }
  })
}

export const statusText = (chain: string[]) => {
  const { army, depth, node } = locate(chain)
  if (!army) return "Not inside an army. Root session must call army_mobilize first."
  return `You are at depth ${depth}/${army.maxDepth}; your budget left: ${remaining(army, node)}.\n${renderTree(army)}`
}

const describeWait = (watched: Node[], timedOut: boolean) => {
  if (watched.length === 0) return "No running children to wait for."
  const line = (node: Node) => `- ${node.sessionID} "${node.description}" ${node.status}`
  const done = watched.filter((node) => node.status !== "running")
  const running = watched.filter((node) => node.status === "running")
  return [
    timedOut ? "Wait ended (timeout or abort)." : "Wait satisfied.",
    `Ended (${done.length}):`,
    ...done.map(line),
    `Still running (${running.length}):`,
    ...running.map(line),
  ].join("\n")
}

// Polls saved state until one (any) or all of the caller's running children end.
export const wait = async (chain: string[], mode: "any" | "all", timeoutMs: number, signal?: AbortSignal) => {
  const { rootID } = locate(chain)
  if (!rootID) return "Not inside an army."
  const callerID = chain[0]
  const snapshot = () => listArmies().find((army) => army.rootID === rootID)
  const watchedIDs = childrenOf(snapshot()!, callerID)
    .filter((node) => node.status === "running")
    .map((node) => node.sessionID)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const army = snapshot()
    const watched = watchedIDs.map((id) => army?.nodes[id]).filter(Boolean) as Node[]
    const done = watched.filter((node) => node.status !== "running").length
    if (watched.length === 0 || (mode === "all" ? done === watched.length : done > 0)) return describeWait(watched, false)
    if (Date.now() >= deadline || signal?.aborted) return describeWait(watched, true)
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

export const orgWorktrees = (porcelain: string, worktree: string) => {
  const prefix = `${worktree.replace(/\/+$/, "")}/.army/`
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path.startsWith(prefix))
}

export const childBranches = (list: string, current: string) =>
  list
    .split("\n")
    .map((line) => line.replace(/^[*+]?\s*/, "").trim())
    .filter((name) => current && name.startsWith(`${current}-`))

export const check = (worktree: string) => {
  try {
    const current = git(worktree, "branch", "--show-current").trim()
    const worktrees = orgWorktrees(git(worktree, "worktree", "list", "--porcelain"), worktree)
    const branches = childBranches(git(worktree, "branch", "--no-merged", "HEAD"), current)
    if (worktrees.length === 0 && branches.length === 0) return `Clean: no child worktrees under ${worktree}/.army/ and no unmerged ${current}-* branches.`
    return [
      `Child worktrees under .army/ (${worktrees.length}):`,
      ...worktrees.map((path) => `- ${path}`),
      `Unmerged ${current}-* branches (${branches.length}):`,
      ...branches.map((name) => `- ${name}`),
    ].join("\n")
  } catch (error: any) {
    return `army_check failed: ${error?.message ?? error}`
  }
}

export const TOOL_DOCS = {
  army_mobilize:
    "Start a hierarchical team run rooted at this session. Call once before delegating to army-officer / army-soldier agents. " +
    `maxDepth defaults to ${DEFAULT_MAX_DEPTH} levels below the General; pass a larger value only if the user asked for it, or 1 for a tiny task (General directs up to ${MAX_SPAN} soldiers). ` +
    `maxAgents caps total spawned agents (default ${DEFAULT_MAX_AGENTS}) unless the user asked for a different cap.`,
  army_status: "Show the army tree: every agent's role, task, status, elapsed time and budget used/allotted, plus totals.",
  army_wait:
    "Block until one (mode any) or all (mode all) of your running children finish, instead of idling. " +
    "Returns which children ended with their status and which are still running.",
  army_check:
    "Before reporting done: list git worktrees under <worktree>/.army/ and local <current branch>-* branches not merged into the current branch.",
}

export const TOOL_SCHEMAS = {
  army_mobilize: {
    type: "object",
    properties: {
      maxDepth: { type: "integer", minimum: 1, description: `Levels below the root, default ${DEFAULT_MAX_DEPTH}; any value >= 1` },
      maxAgents: { type: "integer", minimum: 1, description: `Total agent budget, default ${DEFAULT_MAX_AGENTS}` },
    },
    additionalProperties: false,
  },
  army_status: { type: "object", properties: {}, additionalProperties: false },
  army_wait: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["any", "all"], description: "any (default) or all" },
      timeoutMinutes: { type: "number", minimum: 0, description: "Give up after this long, default 30" },
    },
    additionalProperties: false,
  },
  army_check: {
    type: "object",
    properties: { worktree: { type: "string", description: "Absolute path of your worktree" } },
    required: ["worktree"],
    additionalProperties: false,
  },
} as const
