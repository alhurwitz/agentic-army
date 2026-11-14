// OpenCode adapter. The root session calls army_mobilize, then delegates through the built-in
// `subagent` tool to army-officer / army-soldier agents. Rules live in core/rules.ts.
import { randomUUID } from "node:crypto"

import * as engine from "../core/engine.ts"
import * as rules from "../core/rules.ts"
import { writeAtomic } from "../core/store.ts"
import { renderTree } from "./army-tui/tree.ts"

type Session = { id: string; agent?: string; parentID?: string }

const EVENT_STATUS: Record<string, rules.Status> = {
  "session.execution.started": "running",
  "session.execution.succeeded": "done",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
}

const textOf = (result: any): string => {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return result.map(textOf).join("\n")
  if (result && typeof result === "object") return typeof result.text === "string" ? result.text : JSON.stringify(result)
  return ""
}

const childSessionID = (result: any) => /sessionID:\s*(ses_[A-Za-z0-9]+)/.exec(textOf(result?.content ?? result))?.[1]

const Army = {
  id: "army",
  logic: {
    ...rules,
    renderTree,
    childSessionID,
    orgWorktrees: engine.orgWorktrees,
    childBranches: engine.childBranches,
    writeAtomic,
  },
  async setup(ctx) {
    const keys = new Map<string, string>()
    const spawnKey = (sessionID: string, input: any) => `${sessionID}\u0000${input.agent}\u0000${input.description}`

    const getSession = async (id: string): Promise<Session | undefined> => {
      const result = await ctx.session.get({ sessionID: id }).catch(() => undefined)
      return result?.data ?? result
    }

    // Caller first, then each ancestor session.
    const chainOf = async (sessionID: string) => {
      const chain: string[] = [sessionID]
      let current = await getSession(sessionID)
      while (current?.parentID && !chain.includes(current.parentID)) {
        chain.push(current.parentID)
        current = await getSession(current.parentID)
      }
      return chain
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event?.data ?? event?.properties
          const status = EVENT_STATUS[event?.type]
          if (status && data?.sessionID) engine.ended(data.sessionID, status)
        }
      } catch (error: any) {
        if (!controller.signal.aborted) console.warn("[army] event subscription failed:", error?.message)
      }
    })()

    const options = ctx.options ?? {}

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "army_mobilize",
        description: engine.TOOL_DOCS.army_mobilize,
        input: engine.TOOL_SCHEMAS.army_mobilize,
        async execute(input: any, toolContext: any) {
          const merged = { maxDepth: input.maxDepth ?? options.maxDepth, maxAgents: input.maxAgents ?? options.maxAgents }
          return { content: engine.mobilize(await chainOf(toolContext.sessionID), merged, "opencode") }
        },
      })
      editor.add({
        name: "army_status",
        description: engine.TOOL_DOCS.army_status,
        input: engine.TOOL_SCHEMAS.army_status,
        async execute(_input: any, toolContext: any) {
          return { content: engine.statusText(await chainOf(toolContext.sessionID)) }
        },
      })
      editor.add({
        name: "army_wait",
        description: engine.TOOL_DOCS.army_wait,
        input: engine.TOOL_SCHEMAS.army_wait,
        async execute(input: any, toolContext: any) {
          const timeoutMs = Number(input.timeoutMinutes ?? 30) * 60_000
          return { content: await engine.wait(await chainOf(toolContext.sessionID), input.mode ?? "any", timeoutMs, toolContext.signal) }
        },
      })
      editor.add({
        name: "army_check",
        description: engine.TOOL_DOCS.army_check,
        input: engine.TOOL_SCHEMAS.army_check,
        async execute(input: any) {
          return { content: engine.check(String(input.worktree)) }
        },
      })
    })

    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return
      const input = event.input ?? {}
      const chain = await chainOf(event.sessionID)
      if (input.sessionID && engine.locate(chain).army) return
      const key = randomUUID()
      const decision = engine.requestSpawn({
        chain,
        child: String(input.agent ?? ""),
        prompt: String(input.prompt ?? ""),
        description: String(input.description ?? ""),
        key,
      })
      if (decision.error) throw new Error(`[army] BLOCKED: ${decision.error}`)
      if (decision.prompt === undefined) return
      input.prompt = decision.prompt
      keys.set(spawnKey(event.sessionID, input), key)
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "subagent") return
      const local = spawnKey(event.sessionID, event.input ?? {})
      const key = keys.get(local)
      if (!key) return
      keys.delete(local)
      const childID = event.status === "completed" ? childSessionID(event.result) : undefined
      if (childID) engine.bindSpawn(key, childID)
      else engine.failSpawn(key)
    })

    return () => controller.abort()
  },
}

export default Army
