// Hierarchical agent teams. A root session calls army_mobilize, then delegates through the
// built-in `subagent` tool to `army-officer` / `army-soldier` agents. This plugin enforces the
// shape of the tree, tracks every child, and accounts per-team budgets.
// Rules (checked on every subagent call made inside an army):
//   - depth of root = 0; children may go at most maxDepth levels below root (no fixed cap; maxAgents bounds size)
//   - children must be army-officer or army-soldier; leaf level (depth == maxDepth) is soldier only
//   - the General (depth 0) spawns officers only unless maxDepth == 1
//   - a soldier that spawns is promoted to officer; it borrows the cost of each spawn from its parent
//   - an army member the plugin cannot identify may not spawn army children
//   - every commander has at most MAX_SPAN running direct reports
//   - a officer spawn needs `TROOPS: <n>` as the prompt's first line; it costs the parent 1 + n,
//     a soldier costs 1; a finished officer returns its unused allotment to its parent
//   - every new child also counts against the global maxAgents cap; follow-ups do not
//   - non-army subagents (explore, general, ...) spawned by the General are not tracked or counted
import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { childrenOf, elapsed, readArmies, renderTree } from "./army-tui/tree.ts"

const DEFAULT_MAX_AGENTS = 50
const MAX_SPAN = 5
const MANAGER = "army-officer"
const IC = "army-soldier"
const stateDir = () => process.env.ARMY_STATE_DIR ?? join(homedir(), ".local", "share", "opencode", "army")
const BUDGET_LINE = /^\s*TROOPS:\s*(\d+)\s*$/
const EVENT_STATUS: Record<string, Status> = {
  "session.execution.started": "running",
  "session.execution.succeeded": "done",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
}

type Status = "running" | "done" | "failed" | "interrupted"
type Node = {
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
type Army = {
  rootID: string
  maxDepth: number
  maxAgents: number
  spawned: number
  officers: number
  ics: number
  used: number
  nodes: Record<string, Node>
}
type Session = { id: string; agent?: string; parentID?: string }

const parseBudget = (prompt: string) => {
  const [first, ...rest] = prompt.split("\n")
  const match = BUDGET_LINE.exec(first ?? "")
  if (!match) return { budget: undefined, prompt }
  return { budget: Number(match[1]), prompt: rest.join("\n").replace(/^\n+/, "") }
}

const remaining = (army: Army, node?: Node) => (node ? node.budget - node.used : army.maxAgents - army.used)

const spawnCost = (child: string, budget = 0) => (child === MANAGER ? 1 + budget : 1)

// Shrinks a finished officer's allotment to what it used and returns the rest to its parent.
const settle = (army: Army, node: Node) => {
  const unused = node.budget - node.used
  if (node.agent !== MANAGER || unused <= 0) return 0
  node.budget = node.used
  const parent = army.nodes[node.parentID]
  if (parent) parent.used -= unused
  else army.used -= unused
  return unused
}

type Located = { army?: Army; depth: number; agent?: string; node?: Node }

const isArmyAgent = (agent: string) => agent === MANAGER || agent === IC

const validateShape = ({ army, agent, depth, node }: Located, child: string) => {
  if (!army) return isArmyAgent(child) ? `call army_mobilize before delegating to ${child}.` : undefined
  if (!isArmyAgent(child)) return depth === 0 ? undefined : `inside an army, delegate only to "${MANAGER}" or "${IC}" (got "${child}").`
  if (depth > 0 && !node) return `this session is not a tracked army member, so it cannot command troops. Do the work yourself or report to your officer.`
  if (depth + 1 > army.maxDepth) return `depth limit ${army.maxDepth} reached. Do this work yourself.`
  if (child === MANAGER && depth + 1 === army.maxDepth) return `depth ${depth + 1} is the soldier level (maxDepth ${army.maxDepth}); spawn "${IC}" instead.`
  if (child === IC && depth === 0 && army.maxDepth > 1) return `the General commands officers, not soldiers. Spawn "${MANAGER}" team leads; they command the soldiers.`
  if (agent !== MANAGER && agent !== IC && depth > 0) return `unknown army role "${agent}".`
  return undefined
}

const validateSpan = (army: Army, parentID: string, queued = 0) => {
  const active = Object.values(army.nodes).filter((n) => n.parentID === parentID && n.status === "running").length
  if (active + queued >= MAX_SPAN) return `span of control is ${MAX_SPAN} direct reports. Wait for one to finish (army_wait), or group the work under an "${MANAGER}".`
  return undefined
}

// A soldier (or a soldier already promoted) may borrow from its parent what its own budget lacks.
const shortfall = (army: Army, node: Node | undefined, cost: number) =>
  node && (node.agent === IC || node.promoted) ? Math.max(0, cost - remaining(army, node)) : 0

const parentOf = (army: Army, node: Node) => army.nodes[node.parentID]

const validateBudget = (army: Army, node: Node | undefined, child: string, budget: number | undefined) => {
  if (child === MANAGER && budget === undefined) return `a ${MANAGER} prompt must start with the line "TROOPS: <n>" (agents its subtree may spawn).`
  const cost = spawnCost(child, budget)
  if (army.spawned >= army.maxAgents) return `global agent cap ${army.maxAgents} used up. Reuse existing children via sessionID or do the work yourself.`
  const borrow = shortfall(army, node, cost)
  const available = node ? remaining(army, node) + (borrow ? remaining(army, parentOf(army, node)) : 0) : remaining(army)
  if (cost > available) return `spawning this ${child} costs ${cost} but your budget has ${available} left. Lower TROOPS, reuse children, or do the work yourself.`
  return undefined
}

// Promotes a spawning soldier to officer and moves any borrowed budget from its parent to it.
const promote = (army: Army, node: Node, cost: number) => {
  const borrow = shortfall(army, node, cost)
  if (node.agent === IC) {
    node.agent = MANAGER
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

const charge = (army: Army, node: Node | undefined, child: string, cost: number) => {
  if (node) {
    promote(army, node, cost)
    node.used += cost
  } else army.used += cost
  army.spawned++
  if (child === MANAGER) army.officers++
  else army.ics++
}

const refund = (army: Army, parentID: string, child: string, cost: number) => {
  const parent = army.nodes[parentID]
  if (parent) parent.used -= cost
  else army.used -= cost
  army.spawned--
  if (child === MANAGER) army.officers--
  else army.ics--
}

const writeAtomic = (file: string, data: string) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

const textOf = (result: any): string => {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return result.map(textOf).join("\n")
  if (result && typeof result === "object") return typeof result.text === "string" ? result.text : JSON.stringify(result)
  return ""
}

const childSessionID = (result: any) => /sessionID:\s*(ses_[A-Za-z0-9]+)/.exec(textOf(result?.content ?? result))?.[1]

const orgWorktrees = (porcelain: string, worktree: string) => {
  const prefix = `${worktree.replace(/\/+$/, "")}/.army/`
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path.startsWith(prefix))
}

const childBranches = (list: string, current: string) =>
  list
    .split("\n")
    .map((line) => line.replace(/^[*+]?\s*/, "").trim())
    .filter((name) => current && name.startsWith(`${current}-`))

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

const Army = {
  id: "army",
  logic: {
    parseBudget, remaining, spawnCost, settle, renderTree, childSessionID, orgWorktrees, childBranches,
    validateShape, validateSpan, validateBudget, charge, refund, writeAtomic, MAX_SPAN,
  },
  async setup(ctx) {
    const STORE = stateDir()
    const armies = new Map<string, Army>()
    const owners = new Map<string, Army>()
    const pending = new Map<string, { army: Army; child: string; parentID: string; depth: number; budget: number; cost: number }>()
    const waiters = new Set<() => void>()
    const spawnKey = (sessionID: string, input: any) => `${sessionID}\u0000${input.agent}\u0000${input.description}`

    const save = (army: Army) => {
      mkdirSync(STORE, { recursive: true })
      writeAtomic(join(STORE, `${army.rootID}.json`), JSON.stringify(army, null, 2))
      for (const waiter of waiters) waiter()
    }

    const register = (army: Army) => {
      armies.set(army.rootID, army)
      for (const id of Object.keys(army.nodes)) owners.set(id, army)
    }

    const load = () => {
      mkdirSync(STORE, { recursive: true })
      const { armies: saved, skipped } = readArmies(STORE)
      for (const { army } of saved) register({ used: 0, ...army } as Army)
      for (const line of skipped) console.warn(`[army] skipping unreadable state ${line}`)
    }
    load()

    const getSession = async (id: string): Promise<Session | undefined> => {
      const result = await ctx.session.get({ sessionID: id }).catch(() => undefined)
      return result?.data ?? result
    }

    const known = (id: string): Located | undefined => {
      const root = armies.get(id)
      if (root) return { army: root, depth: 0 }
      const army = owners.get(id)
      const node = army?.nodes[id]
      return node ? { army, depth: node.depth, agent: node.agent, node } : undefined
    }

    // Tracked sessions resolve from the tree; others walk parentID up to a tracked ancestor.
    const locate = async (sessionID: string): Promise<Located> => {
      const caller = await getSession(sessionID)
      let current = caller
      const seen = new Set<string>()
      for (let steps = 0; current && !seen.has(current.id); steps++) {
        seen.add(current.id)
        const hit = known(current.id)
        if (hit) return steps === 0 ? { ...hit, agent: hit.agent ?? caller?.agent } : { army: hit.army, depth: hit.depth + steps, agent: caller?.agent }
        if (!current.parentID) break
        current = await getSession(current.parentID)
      }
      return { army: undefined, depth: 0, agent: caller?.agent }
    }

    const onEvent = (type: string, data: any) => {
      const status = EVENT_STATUS[type]
      const army = status ? owners.get(data?.sessionID) : undefined
      const node = army?.nodes[data.sessionID]
      if (!army || !node || node.status === status) return
      node.status = status
      node.endedAt = status === "running" ? undefined : Date.now()
      if (status !== "running") settle(army, node)
      save(army)
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          onEvent(event?.type, event?.data ?? event?.properties)
        }
      } catch (error: any) {
        if (!controller.signal.aborted) console.warn("[army] event subscription failed:", error?.message)
      }
    })()

    const waitFor = (army: Army, callerID: string, mode: string, timeoutMs: number, signal?: AbortSignal) => {
      const watched = childrenOf(army, callerID).filter((node) => node.status === "running")
      const ended = () => watched.filter((node) => node.status !== "running")
      const satisfied = () => (mode === "all" ? ended().length === watched.length : ended().length > 0)
      return new Promise<{ watched: Node[]; timedOut: boolean }>((resolve) => {
        if (watched.length === 0 || satisfied()) return resolve({ watched, timedOut: false })
        const finish = (timedOut: boolean) => {
          waiters.delete(check)
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          resolve({ watched, timedOut })
        }
        const check = () => satisfied() && finish(false)
        const abort = () => finish(true)
        const timer = setTimeout(abort, timeoutMs)
        signal?.addEventListener("abort", abort)
        waiters.add(check)
      })
    }

    const describeWait = (watched: Node[], timedOut: boolean) => {
      if (watched.length === 0) return "No running children to wait for."
      const line = (node: Node) => `- ${node.sessionID} "${node.description}" ${node.status}`
      const ended = watched.filter((node) => node.status !== "running")
      const running = watched.filter((node) => node.status === "running")
      return [
        timedOut ? "Wait ended (timeout or abort)." : "Wait satisfied.",
        `Ended (${ended.length}):`,
        ...ended.map(line),
        `Still running (${running.length}):`,
        ...running.map(line),
      ].join("\n")
    }

    const statusText = async (sessionID: string) => {
      const { army, depth, node } = await locate(sessionID)
      if (!army) return "Not inside an army. Root session must call army_mobilize first."
      return `You are at depth ${depth}/${army.maxDepth}; your budget left: ${remaining(army, node)}.\n${renderTree(army)}`
    }

    const startOrg = async (input: any, sessionID: string) => {
      const { army: existing } = await locate(sessionID)
      if (existing && existing.rootID !== sessionID) {
        return `Not started: this session is already inside army ${existing.rootID}. Delegate within it.`
      }
      const maxDepth = Math.max(1, Math.trunc(Number(input.maxDepth)))
      const maxAgents = Math.max(1, Math.trunc(Number(input.maxAgents ?? ctx.options?.maxAgents ?? DEFAULT_MAX_AGENTS)))
      const army: Army = existing
        ? Object.assign(existing, { maxDepth, maxAgents })
        : { rootID: sessionID, maxDepth, maxAgents, spawned: 0, officers: 0, ics: 0, used: 0, nodes: {} }
      register(army)
      save(army)
      return (
        `Army ${existing ? "updated" : "started"}: maxDepth=${maxDepth}, maxAgents=${maxAgents}, spawned=${army.spawned}. ` +
        `You are the General (depth 0): follow the army-officer playbook. ` +
        `Delegate with the subagent tool using agent "${maxDepth === 1 ? IC : MANAGER}" (max ${MAX_SPAN} direct reports per commander). ` +
        `A ${MANAGER} prompt must start with the line "TROOPS: <n>" (n = agents its subtree may spawn); it costs you 1 + n.`
      )
    }

    const checkWorktree = (worktree: string) => {
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
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "army_mobilize",
        description:
          "Start a hierarchical team run rooted at this session. Call once before delegating to army-officer / army-soldier subagents. " +
          "Pick maxDepth (>= 1) from the task size. Default 2: General -> officers -> soldiers. 1 = General directs up to " + MAX_SPAN + " soldiers (tiny tasks only); each extra level adds an officer layer. " +
          "maxAgents caps total spawned agents (default 50) unless the user asked for a different cap.",
        input: {
          type: "object",
          properties: {
            maxDepth: { type: "integer", minimum: 1, description: "Levels below the root (>= 1)" },
            maxAgents: { type: "integer", minimum: 1, description: `Total agent budget, default ${DEFAULT_MAX_AGENTS}` },
          },
          required: ["maxDepth"],
          additionalProperties: false,
        },
        async execute(input: any, toolContext: any) {
          return { content: await startOrg(input, toolContext.sessionID) }
        },
      })
      editor.add({
        name: "army_status",
        description: "Show the army tree: every agent's role, task, status, elapsed time and budget used/allotted, plus totals.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input: any, toolContext: any) {
          return { content: await statusText(toolContext.sessionID) }
        },
      })
      editor.add({
        name: "army_wait",
        description:
          "Block until one (mode any) or all (mode all) of your running children finish, instead of idling. " +
          "Returns which children ended with their status and which are still running.",
        input: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["any", "all"], description: "any (default) or all" },
            timeoutMinutes: { type: "number", minimum: 0, description: "Give up after this long, default 30" },
          },
          additionalProperties: false,
        },
        async execute(input: any, toolContext: any) {
          const { army } = await locate(toolContext.sessionID)
          if (!army) return { content: "Not inside an army." }
          const timeoutMs = Number(input.timeoutMinutes ?? 30) * 60_000
          const { watched, timedOut } = await waitFor(army, toolContext.sessionID, input.mode ?? "any", timeoutMs, toolContext.signal)
          return { content: describeWait(watched, timedOut) }
        },
      })
      editor.add({
        name: "army_check",
        description:
          "Before reporting done: list git worktrees under <worktree>/.army/ and local <current branch>-* branches not merged into the current branch.",
        input: {
          type: "object",
          properties: { worktree: { type: "string", description: "Absolute path of your worktree" } },
          required: ["worktree"],
          additionalProperties: false,
        },
        async execute(input: any) {
          try {
            return { content: checkWorktree(String(input.worktree)) }
          } catch (error: any) {
            return { content: `army_check failed: ${error?.message ?? error}` }
          }
        },
      })
    })


    const childPreamble = (army: Army, child: string, depth: number, budget: number) =>
      `[army] You are ${child} at depth ${depth}/${army.maxDepth}` +
      `${child === MANAGER ? `; your children may be ${depth + 1 === army.maxDepth ? `"${IC}" only` : `"${MANAGER}" or "${IC}"`}` : ""}. ` +
      `Budget left: ${budget}.\n\n`

    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return
      const input = event.input ?? {}
      const child = String(input.agent ?? "")
      const located = await locate(event.sessionID)
      if (located.army && input.sessionID) return
      const shapeError = validateShape(located, child)
      if (shapeError) throw new Error(`[army] BLOCKED: ${shapeError}`)
      const army = located.army
      if (!army || !isArmyAgent(child)) return

      const parsed = parseBudget(String(input.prompt ?? ""))
      const queued = [...pending.values()].filter((p) => p.parentID === event.sessionID).length
      const budgetError = validateSpan(army, event.sessionID, queued) ?? validateBudget(army, located.node, child, parsed.budget)
      if (budgetError) throw new Error(`[army] BLOCKED: ${budgetError}`)

      const budget = child === MANAGER ? (parsed.budget ?? 0) : 0
      const cost = spawnCost(child, budget)
      charge(army, located.node, child, cost)
      pending.set(spawnKey(event.sessionID, input), { army, child, parentID: event.sessionID, depth: located.depth + 1, budget, cost })
      input.prompt = childPreamble(army, child, located.depth + 1, budget) + parsed.prompt
      save(army)
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "subagent") return
      const key = spawnKey(event.sessionID, event.input ?? {})
      const spawn = pending.get(key)
      if (!spawn) return
      pending.delete(key)
      const sessionID = event.status === "completed" ? childSessionID(event.result) : undefined
      if (!sessionID) {
        refund(spawn.army, spawn.parentID, spawn.child, spawn.cost)
        return save(spawn.army)
      }
      spawn.army.nodes[sessionID] = {
        sessionID,
        parentID: spawn.parentID,
        agent: spawn.child,
        description: String(event.input?.description ?? ""),
        depth: spawn.depth,
        status: "running",
        startedAt: Date.now(),
        budget: spawn.budget,
        used: 0,
      }
      owners.set(sessionID, spawn.army)
      save(spawn.army)
    })

    return () => controller.abort()
  },
}

export default Army
