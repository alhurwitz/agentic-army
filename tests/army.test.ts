import { describe, test, expect } from "./support.ts"
import Army from "../plugin/army.ts"

const { parseBudget, remaining, spawnCost, settle, renderTree, childSessionID, orgWorktrees, childBranches } = Army.logic

const makeOrg = () => ({ rootID: "ses_root", maxDepth: 2, maxAgents: 10, spawned: 0, officers: 0, ics: 0, used: 0, nodes: {} as Record<string, any> })
const node = (over: Record<string, any>) => ({
  sessionID: "ses_m",
  parentID: "ses_root",
  agent: "army-officer",
  description: "team",
  depth: 1,
  status: "running",
  startedAt: 0,
  budget: 4,
  used: 0,
  ...over,
})

describe("parseBudget", () => {
  test("strips marker line", () => {
    expect(parseBudget("TROOPS: 5\nDo the thing")).toEqual({ budget: 5, prompt: "Do the thing" })
  })
  test("missing marker", () => {
    expect(parseBudget("Do it\nTROOPS: 5")).toEqual({ budget: undefined, prompt: "Do it\nTROOPS: 5" })
  })
})

describe("budget accounting", () => {
  test("costs", () => {
    expect(spawnCost("army-officer", 4)).toBe(5)
    expect(spawnCost("army-soldier")).toBe(1)
  })
  test("root and node remaining", () => {
    const army = makeOrg()
    army.used = 5
    expect(remaining(army)).toBe(5)
    expect(remaining(army, node({ used: 1 }))).toBe(3)
  })
  test("finished manager returns unused to root", () => {
    const army = makeOrg()
    army.used = 5
    const m = node({ used: 1 })
    army.nodes[m.sessionID] = m
    expect(settle(army, m)).toBe(3)
    expect(army.used).toBe(2)
    expect(m.budget).toBe(1)
    expect(settle(army, m)).toBe(0)
  })
  test("nested manager returns to parent manager", () => {
    const army = makeOrg()
    const parent = node({ used: 3 })
    const child = node({ sessionID: "ses_c", parentID: "ses_m", budget: 2, used: 0 })
    army.nodes = { ses_m: parent, ses_c: child }
    settle(army, child)
    expect(parent.used).toBe(1)
  })
  test("ic settles nothing", () => {
    const army = makeOrg()
    expect(settle(army, node({ agent: "army-soldier", budget: 0 }))).toBe(0)
  })
})

describe("renderTree", () => {
  test("indents children", () => {
    const army = makeOrg()
    army.spawned = 2
    army.nodes = {
      ses_m: node({}),
      ses_i: node({ sessionID: "ses_i", parentID: "ses_m", agent: "army-soldier", description: "fix", status: "done", startedAt: 0, endedAt: 65_000, depth: 2, budget: 0 }),
    }
    const text = renderTree(army, 5000)
    expect(text).toContain('  - officer "team" running 5s, budget 0/4 [ses_m]')
    expect(text).toContain('    - soldier "fix" done 1m05s [ses_i]')
    expect(text).toContain("Totals: spawned 2/10 (officers 0, soldiers 0); running 1.")
  })
})

describe("parsers", () => {
  test("child session id", () => {
    expect(childSessionID({ content: "started\nsessionID: ses_abc123 running" })).toBe("ses_abc123")
    expect(childSessionID({ content: [{ type: "text", text: "sessionID: ses_x" }] })).toBe("ses_x")
    expect(childSessionID({ content: "nope" })).toBeUndefined()
  })
  test("worktrees under .army", () => {
    const out = "worktree /w\nHEAD x\n\nworktree /w/.army/a\nbranch y\n\nworktree /other\n"
    expect(orgWorktrees(out, "/w/")).toEqual(["/w/.army/a"])
  })
  test("unmerged child branches", () => {
    expect(childBranches("  feat-a\n+ feat-b\n  other\n* feat\n", "feat")).toEqual(["feat-a", "feat-b"])
  })
})
