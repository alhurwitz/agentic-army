import { describe, test, expect } from "./support.ts"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { repoOf } from "../plugin/army-tui/tree.ts"

process.env.ARMY_STATE_DIR = mkdtempSync(join(tmpdir(), "army-harness-"))
const { handle, findAgentID } = await import("../bin/army-hook.ts")
const { callTool, dispatch } = await import("../bin/army-mcp.ts")
const engine = await import("../core/engine.ts")
const setup = await import("../scripts/setup.ts")

let counter = 0
const uid = (prefix: string) => `${prefix}${Date.now()}${++counter}`

// Simulates one harness session: hook events in, decisions out.
const session = (harness: "claude" | "copilot" | "codex") => {
  const sessionID = uid("sess")
  const base = { session_id: sessionID, cwd: "/tmp" }
  const pre = (tool: string, input: any, agent?: { id: string; type: string }, toolUseID = uid("tu")) => ({
    toolUseID,
    out: handle(harness, { ...base, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: toolUseID, ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}) }) as any,
  })
  const decision = (out: any) => (harness === "copilot" ? out?.permissionDecision : out?.hookSpecificOutput?.permissionDecision)
  const args = (out: any) => (harness === "copilot" ? out?.modifiedArgs : out?.hookSpecificOutput?.updatedInput)
  const army = async (tool: string, input: any, agent?: { id: string; type: string }) => callTool(tool, args(pre(`mcp__army__${tool}`, input, agent).out))
  const spawn = (type: string, prompt: string, agent?: { id: string; type: string }) => {
    const { toolUseID, out } = pre("Agent", { subagent_type: type, description: `do ${type}`, prompt }, agent)
    return { toolUseID, out, decision: decision(out), args: args(out) }
  }
  const posted = (toolUseID: string, childID: string) =>
    handle(harness, { ...base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: toolUseID, tool_response: { status: "async_launched", agentId: childID } })
  const stop = (id: string, type: string) => handle(harness, { ...base, hook_event_name: "SubagentStop", agent_id: id, agent_type: type })
  return { sessionID, army, spawn, posted, stop, decision }
}

describe("hook: claude", () => {
  test("full chain: mobilize, officer, soldiers, stop", async () => {
    const s = session("claude")
    expect(await s.army("army_mobilize", { maxDepth: 2, maxAgents: 10 })).toContain("Army started")

    const soldierFromGeneral = s.spawn("army-soldier", "do it")
    expect(soldierFromGeneral.decision).toBe("deny")

    const officer = s.spawn("army-officer", "TROOPS: 3\nlead team")
    expect(officer.decision).toBe("allow")
    expect(officer.args.prompt).toStartWith("[army] You are army-officer at depth 1/2")
    expect(officer.args.prompt).not.toContain("TROOPS:")
    s.posted(officer.toolUseID, "agentOff1")

    const me = { id: "agentOff1", type: "army-officer" }
    const soldier = s.spawn("army-soldier", "fix bug", me)
    expect(soldier.decision).toBe("allow")
    s.posted(soldier.toolUseID, "agentSol1")
    expect(s.spawn("army-officer", "TROOPS: 1\nx", me).decision).toBe("deny")

    const status = await s.army("army_status", {}, me)
    expect(status).toContain("You are at depth 1/2")
    expect(status).toContain('soldier "do army-soldier" running')

    const waiting = s.army("army_wait", { mode: "any", timeoutMinutes: 1 }, me)
    s.stop("agentSol1", "army-soldier")
    expect(await waiting).toContain("Wait satisfied.")
    expect(await s.army("army_status", {}, me)).toContain('soldier "do army-soldier" done')
  })

  test("non-army helpers pass through untouched", async () => {
    const s = session("claude")
    await s.army("army_mobilize", {})
    expect(s.spawn("Explore", "look around").out).toBeUndefined()
  })

  test("spawning army agents before mobilize is blocked", () => {
    const s = session("claude")
    expect(s.spawn("army-officer", "TROOPS: 1\nx").decision).toBe("deny")
  })

  test("untracked subagent cannot command troops", async () => {
    const s = session("claude")
    await s.army("army_mobilize", { maxDepth: 3 })
    expect(s.spawn("army-soldier", "x", { id: "agentStray", type: "Explore" }).decision).toBe("deny")
  })
})

describe("hook: copilot", () => {
  test("uses permissionDecision/modifiedArgs and binds children lazily", async () => {
    const s = session("copilot")
    await s.army("army_mobilize", { maxDepth: 3, maxAgents: 10 })
    const officer = s.spawn("army-officer", "TROOPS: 4\nlead")
    expect(officer.out.permissionDecision).toBe("allow")
    expect(officer.out.modifiedArgs.prompt).toContain("[army] You are army-officer")

    // No PostToolUse id: the officer's first own tool call identifies it.
    const me = { id: "copOff", type: "army-officer" }
    const soldier = s.spawn("army-soldier", "unit", me)
    expect(soldier.decision).toBe("allow")
    expect(soldier.args.prompt).toContain("depth 2/3")
  })
})

describe("hook: codex", () => {
  test("SubagentStop prints JSON; spawn_agent with message field is rewritten", async () => {
    const s = session("codex")
    await s.army("army_mobilize", { maxDepth: 2 })
    const out = handle("codex", {
      session_id: s.sessionID,
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_use_id: uid("tu"),
      tool_input: { agent_type: "army-officer", message: "TROOPS: 2\nlead" },
    }) as any
    expect(out.hookSpecificOutput.updatedInput.message).toContain("[army] You are army-officer")
    expect(handle("codex", { session_id: s.sessionID, hook_event_name: "SubagentStop", agent_id: "nobody", agent_type: "army-soldier" })).toEqual({})
  })
})

describe("hook: codex encrypted spawn", () => {
  test("namespaced tool, budget from task_name, preamble via SubagentStart", async () => {
    const s = session("codex")
    await s.army("army_mobilize", { maxDepth: 2, maxAgents: 10 })
    const base = { session_id: s.sessionID, hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent" }
    const secret = "gAAAAABq-Fr4h_-_d41gGLpeoi5ZLbd0lpSxAeB35Wu4YY6jKIlJW4a"

    const noBudget = handle("codex", { ...base, tool_use_id: uid("tu"), tool_input: { agent_type: "army-officer", message: secret } }) as any
    expect(noBudget.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(noBudget.hookSpecificOutput.permissionDecisionReason).toContain("task_name")

    const ok = handle("codex", { ...base, tool_use_id: uid("tu"), tool_input: { agent_type: "army-officer", task_name: "team_api_troops_3", message: secret } })
    expect(ok).toBeUndefined()

    const start = handle("codex", { session_id: s.sessionID, hook_event_name: "SubagentStart", agent_id: "cdxOff", agent_type: "army-officer" }) as any
    expect(start.hookSpecificOutput.additionalContext).toContain("[army] You are army-officer at depth 1/2")
    expect(start.hookSpecificOutput.additionalContext).toContain("Budget left: 3")
    expect(await s.army("army_status", {})).toContain('officer "team_api_troops_3" running')
  })
})

describe("hook helpers", () => {
  test("findAgentID handles objects, nested, and JSON strings", () => {
    expect(findAgentID({ agentId: "abc123" })).toBe("abc123")
    expect(findAgentID({ result: { agent_id: "def456" } })).toBe("def456")
    expect(findAgentID('{"agentId":"ghi789"}')).toBe("ghi789")
    expect(findAgentID("spawned agent_id: jkl012abc")).toBe("jkl012abc")
    expect(findAgentID("nothing")).toBeUndefined()
  })

  test("hook ignores unrelated tools", () => {
    expect(handle("claude", { session_id: "x", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toBeUndefined()
  })
})

describe("mcp server", () => {
  const run = async (message: any) => {
    const lines: string[] = []
    const write = process.stdout.write
    process.stdout.write = ((chunk: any) => lines.push(String(chunk)) && true) as any
    try {
      await dispatch(message)
    } finally {
      process.stdout.write = write
    }
    return lines.length ? JSON.parse(lines[0]) : undefined
  }

  test("initialize, list, and call without caller", async () => {
    expect((await run({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name).toBe("army")
    const names = (await run({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((t: any) => t.name)
    expect(names).toEqual(["army_mobilize", "army_status", "army_wait", "army_check"])
    const call = await run({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "army_status", arguments: {} } })
    expect(call.result.content[0].text).toContain("army hook not installed")
    expect(await run({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
    expect((await run({ jsonrpc: "2.0", id: 4, method: "nope" })).error.code).toBe(-32601)
  })
})

describe("setup", () => {
  const withHome = async (fn: (home: string) => unknown) => {
    const home = mkdtempSync(join(tmpdir(), "army-home-"))
    const prev = { HOME: process.env.HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, ARMY_BIN_DIR: process.env.ARMY_BIN_DIR }
    process.env.HOME = home
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.ARMY_BIN_DIR
    try {
      await fn(home)
    } finally {
      Object.assign(process.env, prev)
      for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]
    }
  }
  const quiet = () => {}

  test("install and uninstall all harnesses keep user config intact", () =>
    withHome(async (home) => {
      mkdirSync(join(home, ".claude"), { recursive: true })
      const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "my-check.sh" }] }
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { PreToolUse: [userHook] } }))
      mkdirSync(join(home, ".codex"), { recursive: true })
      writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n')

      setup.install([...setup.HARNESSES], quiet)
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
      expect(settings.model).toBe("opus")
      expect(settings.hooks.PreToolUse).toHaveLength(2)
      expect(settings.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("20")
      expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.army.args[1]).toBe("claude")
      expect(JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")).mcpServers.army.type).toBe("local")
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.army]")
      for (const path of [
        ".config/opencode/agents/army-officer.md",
        ".claude/agents/army-soldier.md",
        ".claude/commands/army.md",
        ".claude/commands/army-status.md",
        ".copilot/agents/army-officer.agent.md",
        ".copilot/skills/army",
        ".copilot/skills/army-status",
        ".copilot/hooks/army.json",
        ".codex/prompts/army.md",
        ".codex/prompts/army-status.md",
        ".local/bin/army-status",
      ])
        expect(lstatSync(join(home, path)).isSymbolicLink()).toBe(true)

      const pluginEntry = join(home, ".config", "opencode", "plugins", "army.ts")
      expect(lstatSync(pluginEntry).isFile()).toBe(true)
      expect(typeof (await import(pluginEntry)).default.setup).toBe("function")
      const codexAgent = join(home, ".codex", "agents", "army-officer.toml")
      expect(lstatSync(codexAgent).isFile()).toBe(true)
      expect(readFileSync(codexAgent, "utf8")).toContain('name = "army-officer"')

      setup.install([...setup.HARNESSES], quiet)
      expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.PreToolUse).toHaveLength(2)
      expect(existsSync(join(home, ".codex", "agents", ".army-backup"))).toBe(false)

      setup.uninstall([...setup.HARNESSES], quiet)
      const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
      expect(after.hooks.PreToolUse).toEqual([userHook])
      expect(after.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBeUndefined()
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe('model = "x"\n')
      expect(existsSync(join(home, ".claude", "agents", "army-officer.md"))).toBe(false)
      expect(existsSync(codexAgent)).toBe(false)
      expect(existsSync(join(home, ".local", "bin", "army-status"))).toBe(false)
      expect(existsSync(pluginEntry)).toBe(false)
    }))

  test("rendered playbooks have no placeholders", () => {
    for (const harness of setup.HARNESSES) for (const name of ["officer", "soldier", "army"] as const) expect(setup.render(harness, name)).not.toContain("{{")
  })

  test("parseHarnesses", () => {
    expect(setup.parseHarnesses([])).toEqual([...setup.HARNESSES])
    expect(setup.parseHarnesses(["claude", "codex"])).toEqual(["claude", "codex"])
    expect(() => setup.parseHarnesses(["vim"])).toThrow(/unknown harness/)
  })
})

test("engine exports tool docs for every tool", () => {
  expect(Object.keys(engine.TOOL_DOCS).sort()).toEqual(Object.keys(engine.TOOL_SCHEMAS).sort())
})

describe("runs are scoped to the repo they started in", () => {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args]).status
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "army-repo-"))
    git(dir, "init", "-q")
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    return dir
  }
  const status = (cwd: string, ...args: string[]) =>
    spawnSync(join(import.meta.dirname, "..", "bin", "army-status"), args, { cwd, env: process.env }).stdout.toString()

  test("mobilize records the main checkout, even from a worktree", () => {
    const main = repo()
    git(main, "worktree", "add", "-q", "-b", "wt", join(main, ".army", "wt"))
    expect(repoOf(join(main, ".army", "wt"))).toBe(repoOf(main))
    const root = uid("scoped")
    engine.mobilize([root], { maxDepth: 1 }, "claude", join(main, ".army", "wt"))
    expect(engine.locate([root]).army?.repo).toBe(repoOf(main))
  })

  test("army-status shows only this repo's runs; --all shows every run", () => {
    const mine = repo()
    const other = repo()
    const root = uid("mine")
    engine.mobilize([root], { maxDepth: 1 }, "claude", mine)
    expect(status(mine)).toContain(`General ${root}`)
    expect(status(other)).toContain(`No army runs in ${repoOf(other)}`)
    expect(status(other, "--all")).toContain(`General ${root}`)
    expect(status(other, root)).toContain(`General ${root}`)
  })
})

test("run state moves from the old OpenCode folder to the agentic-army folder", async () => {
  const { stateDir, DEFAULT_STATE_DIR, LEGACY_STATE_DIR } = await import("../plugin/army-tui/tree.ts")
  const saved = { HOME: process.env.HOME, ARMY_STATE_DIR: process.env.ARMY_STATE_DIR }
  process.env.HOME = mkdtempSync(join(tmpdir(), "army-home-"))
  delete process.env.ARMY_STATE_DIR
  delete process.env.XDG_STATE_HOME
  try {
    mkdirSync(LEGACY_STATE_DIR(), { recursive: true })
    writeFileSync(join(LEGACY_STATE_DIR(), "ses_old.json"), "{}")
    expect(stateDir()).toBe(DEFAULT_STATE_DIR())
    expect(DEFAULT_STATE_DIR()).toContain(join(".local", "state", "agentic-army"))
    expect(existsSync(join(DEFAULT_STATE_DIR(), "ses_old.json"))).toBe(true)
    expect(existsSync(LEGACY_STATE_DIR())).toBe(false)
  } finally {
    process.env.HOME = saved.HOME
    process.env.ARMY_STATE_DIR = saved.ARMY_STATE_DIR
  }
})
