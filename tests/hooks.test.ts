import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.ARMY_STATE_DIR = mkdtempSync(join(tmpdir(), "army-state-"))
const STATE = process.env.ARMY_STATE_DIR
const { default: Army } = await import("../plugin/army.ts")
const { readArmies } = await import("../plugin/army-tui/tree.ts")

type Session = { id: string; agent?: string; parentID?: string }

// Minimal fake of the OpenCode plugin context: sessions, an event stream, tools, and hooks.
const harness = async () => {
  const sessions: Record<string, Session> = {}
  const tools: Record<string, any> = {}
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const queue: any[] = []
  let wake = () => {}
  const ctx = {
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ data: sessions[sessionID] }) },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length) yield queue.shift()
            await new Promise<void>((resolve) => (wake = resolve))
          }
        },
      }),
    },
    tool: {
      transform: async (fn: any) => fn({ add: (tool: any) => (tools[tool.name] = tool) }),
      hook: async (name: string, fn: any) => (hooks[name] = fn),
    },
  }
  const stop = await Army.setup(ctx)
  let counter = 0

  const root = `ses_root${Date.now()}${Math.random().toString(36).slice(2)}`
  sessions[root] = { id: root, agent: "build" }

  const mobilize = (maxDepth: number, maxAgents = 50) => tools.army_mobilize.execute({ maxDepth, maxAgents }, { sessionID: root })

  // Runs a subagent call through both hooks; returns the child's session id.
  const spawn = async (parentID: string, agent: string, prompt = "do it", extra: Record<string, any> = {}) => {
    const input = { agent, description: `task ${++counter}`, prompt, ...extra }
    await hooks["execute.before"]({ tool: "subagent", sessionID: parentID, input })
    const child = `ses_c${counter}x${root.slice(-6)}`
    sessions[child] = { id: child, agent, parentID }
    await hooks["execute.after"]({ tool: "subagent", sessionID: parentID, input, status: "completed", result: { content: `sessionID: ${child}` } })
    return child
  }

  const finish = async (sessionID: string) => {
    queue.push({ type: "session.execution.succeeded", data: { sessionID } })
    wake()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const state = () => JSON.parse(readFileSync(join(STATE, `${root}.json`), "utf8"))

  return { root, sessions, tools, hooks, mobilize, spawn, finish, state, stop }
}

let h: Awaited<ReturnType<typeof harness>>
beforeEach(async () => {
  h?.stop?.()
  h = await harness()
})

describe("chain of command", () => {
  test("army children need army_mobilize first", async () => {
    await expect(h.spawn(h.root, "army-soldier")).rejects.toThrow(/army_mobilize/)
  })

  test("General may not spawn soldiers when maxDepth >= 2", async () => {
    await h.mobilize(2)
    await expect(h.spawn(h.root, "army-soldier")).rejects.toThrow(/commands officers/)
  })

  test("General may spawn soldiers when maxDepth == 1", async () => {
    await h.mobilize(1)
    await h.spawn(h.root, "army-soldier")
    expect(h.state().ics).toBe(1)
  })

  test("officer at the leaf level is blocked", async () => {
    await h.mobilize(2)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 3\ngo")
    await expect(h.spawn(officer, "army-officer", "TROOPS: 1\ngo")).rejects.toThrow(/soldier level/)
  })

  test("officer prompt requires TROOPS", async () => {
    await h.mobilize(2)
    await expect(h.spawn(h.root, "army-officer", "go")).rejects.toThrow(/TROOPS/)
  })

  test("untracked session inside an army cannot command troops", async () => {
    await h.mobilize(3)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 3\ngo")
    h.sessions.ses_stray = { id: "ses_stray", agent: "general", parentID: officer }
    await expect(h.spawn("ses_stray", "army-soldier")).rejects.toThrow(/not a tracked army member/)
  })

  test("non-army child below the General is blocked", async () => {
    await h.mobilize(2)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 3\ngo")
    await expect(h.spawn(officer, "explore")).rejects.toThrow(/delegate only to/)
  })
})

describe("non-army helpers", () => {
  test("General's explore spawns are not counted", async () => {
    await h.mobilize(2, 5)
    await h.spawn(h.root, "explore")
    await h.spawn(h.root, "general")
    const army = h.state()
    expect(army.spawned).toBe(0)
    expect(army.used).toBe(0)
    expect(Object.keys(army.nodes)).toHaveLength(0)
  })
})

describe("promotion", () => {
  test("soldier that spawns becomes officer and borrows from its parent", async () => {
    await h.mobilize(3, 20)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 4\ngo")
    const soldier = await h.spawn(officer, "army-soldier")
    await h.spawn(soldier, "army-soldier")
    await h.spawn(soldier, "army-soldier")
    const army = h.state()
    expect(army.nodes[soldier].agent).toBe("army-officer")
    expect(army.nodes[soldier].promoted).toBe(true)
    expect(army.nodes[soldier].budget).toBe(2)
    expect(army.nodes[soldier].used).toBe(2)
    expect(army.nodes[officer].used).toBe(3)
    expect(army.officers).toBe(2)
    expect(army.ics).toBe(2)
  })

  test("promotion blocked when parent budget is short", async () => {
    await h.mobilize(3, 20)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 1\ngo")
    const soldier = await h.spawn(officer, "army-soldier")
    await expect(h.spawn(soldier, "army-soldier")).rejects.toThrow(/budget/)
    expect(h.state().nodes[soldier].agent).toBe("army-soldier")
  })

  test("soldier at the depth limit cannot spawn", async () => {
    await h.mobilize(2, 20)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 4\ngo")
    const soldier = await h.spawn(officer, "army-soldier")
    await expect(h.spawn(soldier, "army-soldier")).rejects.toThrow(/depth limit/)
  })

  test("promoted officer returns unused borrow when it finishes", async () => {
    await h.mobilize(3, 20)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 4\ngo")
    const soldier = await h.spawn(officer, "army-soldier")
    await h.spawn(soldier, "army-soldier")
    await h.finish(soldier)
    const army = h.state()
    expect(army.nodes[soldier].status).toBe("done")
    expect(army.nodes[officer].used).toBe(2)
  })
})

describe("span of control", () => {
  test("sixth running direct report is blocked until one finishes", async () => {
    await h.mobilize(2, 50)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 10\ngo")
    const kids = []
    for (let i = 0; i < Army.logic.MAX_SPAN; i++) kids.push(await h.spawn(officer, "army-soldier"))
    await expect(h.spawn(officer, "army-soldier")).rejects.toThrow(/span of control/)
    await h.finish(kids[0])
    await h.spawn(officer, "army-soldier")
    expect(h.state().nodes[officer].used).toBe(6)
  })
})

describe("follow-ups and failures", () => {
  test("follow-up via sessionID is not charged", async () => {
    await h.mobilize(2)
    const officer = await h.spawn(h.root, "army-officer", "TROOPS: 2\ngo")
    await h.hooks["execute.before"]({ tool: "subagent", sessionID: h.root, input: { agent: "army-officer", description: "again", prompt: "more", sessionID: officer } })
    expect(h.state().spawned).toBe(1)
  })

  test("failed spawn refunds budget and counts", async () => {
    await h.mobilize(2, 10)
    const input = { agent: "army-officer", description: "fails", prompt: "TROOPS: 3\ngo" }
    await h.hooks["execute.before"]({ tool: "subagent", sessionID: h.root, input })
    expect(h.state().used).toBe(4)
    await h.hooks["execute.after"]({ tool: "subagent", sessionID: h.root, input, status: "error", result: "boom" })
    const army = h.state()
    expect(army.used).toBe(0)
    expect(army.spawned).toBe(0)
    expect(army.officers).toBe(0)
  })
})

describe("state files", () => {
  test("saves leave no temp files and parse cleanly", async () => {
    await h.mobilize(2)
    await h.spawn(h.root, "army-officer", "TROOPS: 2\ngo")
    expect(readdirSync(STATE).filter((f) => f.endsWith(".tmp"))).toHaveLength(0)
    expect(h.state().rootID).toBe(h.root)
  })

  test("readArmies skips corrupt and foreign files", () => {
    writeFileSync(join(STATE, "ses_bad.json"), "{not json")
    writeFileSync(join(STATE, "ses_foreign.json"), JSON.stringify({ hello: 1 }))
    const { armies, skipped } = readArmies(STATE)
    expect(skipped.some((line) => line.includes("ses_bad.json"))).toBe(true)
    expect(skipped.some((line) => line.includes("ses_foreign.json"))).toBe(true)
    expect(armies.every(({ army }) => typeof army.rootID === "string")).toBe(true)
  })

  test("plugin starts with corrupt state present", async () => {
    writeFileSync(join(STATE, "ses_bad2.json"), "{nope")
    const fresh = await harness()
    expect((await fresh.mobilize(1)).content).toContain("Army started")
    fresh.stop()
  })
})
