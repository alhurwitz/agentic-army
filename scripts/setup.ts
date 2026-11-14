#!/usr/bin/env bun
// Renders the playbooks for each harness into dist/ and wires them, the hook command, and the
// MCP server into each harness's config. Usage: setup.ts <install|uninstall> <harness...|all>
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..")
export const HARNESSES = ["opencode", "claude", "copilot", "codex"] as const
export type Harness = (typeof HARNESSES)[number]

const BUN = join(REPO, "bin", "army-run")
const HOOK = join(REPO, "bin", "army-hook.ts")
const MCP = join(REPO, "bin", "army-mcp.ts")
const STAMP = new Date().toISOString().replace(/\D/g, "").slice(0, 14)
const TOML_BEGIN = "# >>> agentic-army >>>"
const TOML_END = "# <<< agentic-army <<<"
const CLAUDE_DEPTH = "20"

const home = () => process.env.HOME ?? homedir()
const opencodeDir = () => process.env.OPENCODE_CONFIG_DIR ?? join(home(), ".config", "opencode")
const binDir = () => process.env.ARMY_BIN_DIR ?? join(home(), ".local", "bin")
const dist = (harness: Harness, ...parts: string[]) => join(REPO, "dist", harness, ...parts)

const DESCRIPTIONS = {
  officer:
    "Team officer in an army run (after army_mobilize). Splits its brief into a dependency plan, delegates to child army-officer / army-soldier agents in parallel, each in its own git worktree, merges their branches, and reports one summary to its parent. Does not edit code itself.",
  soldier:
    "Individual contributor in an army run. Does one well-scoped unit of work in the git worktree its officer assigned, commits it, and reports back. If the unit turns out too big, it may split it and is promoted to officer for that work.",
  army: "Run a task with a chain of command: the General commands officers and soldiers",
}

const SPAWN: Record<Harness, string> = {
  opencode: 'the `subagent` tool (agent `army-officer` or `army-soldier`)',
  claude: "the Agent tool (`subagent_type` `army-officer` or `army-soldier`)",
  copilot: "the task tool (agent `army-officer` or `army-soldier`)",
  codex: "your spawn-agent tool (agent type `army-officer` or `army-soldier`)",
}
const RETRY: Record<Harness, string> = {
  opencode: "retry once via its sessionID with a corrected brief",
  claude: "retry once by sending it a corrected brief (resume it), or spawn a fresh one",
  copilot: "retry once with a corrected brief in a fresh spawn",
  codex: "retry once by messaging its thread with a corrected brief, or spawn a fresh one",
}
const ARGS: Record<Harness, string> = { opencode: "$ARGUMENTS", claude: "$ARGUMENTS", copilot: "the user's request", codex: "$ARGUMENTS" }

const officerPath = (harness: Harness) =>
  ({
    opencode: join(opencodeDir(), "agents", "army-officer.md"),
    claude: join(home(), ".claude", "agents", "army-officer.md"),
    copilot: join(home(), ".copilot", "agents", "army-officer.agent.md"),
    codex: join(home(), ".codex", "agents", "army-officer.toml"),
  })[harness]

export const render = (harness: Harness, name: "officer" | "soldier" | "army") =>
  readFileSync(join(REPO, "playbooks", `${name}.md`), "utf8")
    .replaceAll("{{SPAWN}}", SPAWN[harness])
    .replaceAll("{{RETRY}}", RETRY[harness])
    .replaceAll("{{ARGS}}", ARGS[harness])
    .replaceAll("{{OFFICER_PATH}}", officerPath(harness))
    .trimEnd() + "\n"

const yaml = (fields: Record<string, string | undefined>) =>
  ["---", ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""].join("\n")

const tomlString = (text: string) => `"""\n${text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"')}"""`

const write = (file: string, content: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

// Renders every file a harness gets into dist/<harness>/; returns [source, destination] pairs to link.
export const build = (harness: Harness): [string, string][] => {
  const officer = render(harness, "officer")
  const soldier = render(harness, "soldier")
  const army = render(harness, "army")
  const soldierModel = process.env[`ARMY_${harness.toUpperCase()}_SOLDIER_MODEL`]
  if (harness === "opencode") {
    const permit = (effect: string) => `permissions:\n  - action: subagent\n    resource: "*"\n    effect: ${effect}\n`
    write(dist(harness, "army-officer.md"), yaml({ name: "army-officer", description: DESCRIPTIONS.officer, mode: "subagent" }).replace(/---\n$/, permit("allow") + "---\n") + "\n" + officer)
    write(dist(harness, "army-soldier.md"), yaml({ name: "army-soldier", description: DESCRIPTIONS.soldier, mode: "subagent", model: soldierModel }).replace(/---\n$/, permit("allow") + "---\n") + "\n" + soldier)
    write(dist(harness, "army.md"), yaml({ description: DESCRIPTIONS.army }) + "\n" + army)
    const config = opencodeDir()
    return [
      [join(REPO, "plugin", "army.ts"), join(config, "plugins", "army.ts")],
      [join(REPO, "plugin", "army-tui"), join(config, "plugins", "army-tui")],
      [dist(harness, "army-officer.md"), join(config, "agents", "army-officer.md")],
      [dist(harness, "army-soldier.md"), join(config, "agents", "army-soldier.md")],
      [dist(harness, "army.md"), join(config, "commands", "army.md")],
    ]
  }
  if (harness === "claude") {
    write(dist(harness, "army-officer.md"), yaml({ name: "army-officer", description: DESCRIPTIONS.officer }) + "\n" + officer)
    write(dist(harness, "army-soldier.md"), yaml({ name: "army-soldier", description: DESCRIPTIONS.soldier, model: soldierModel }) + "\n" + soldier)
    write(dist(harness, "army.md"), yaml({ description: DESCRIPTIONS.army, "argument-hint": "<task>" }) + "\n" + army)
    const root = join(home(), ".claude")
    return [
      [dist(harness, "army-officer.md"), join(root, "agents", "army-officer.md")],
      [dist(harness, "army-soldier.md"), join(root, "agents", "army-soldier.md")],
      [dist(harness, "army.md"), join(root, "commands", "army.md")],
    ]
  }
  if (harness === "copilot") {
    write(dist(harness, "army-officer.agent.md"), yaml({ name: "army-officer", description: DESCRIPTIONS.officer }) + "\n" + officer)
    write(dist(harness, "army-soldier.agent.md"), yaml({ name: "army-soldier", description: DESCRIPTIONS.soldier, model: soldierModel }) + "\n" + soldier)
    write(dist(harness, "army", "SKILL.md"), yaml({ name: "army", description: `${DESCRIPTIONS.army}. Use when the user asks to run a task as an army.` }) + "\n" + army)
    write(dist(harness, "hooks.json"), JSON.stringify(copilotHooks(), null, 2) + "\n")
    const root = join(home(), ".copilot")
    return [
      [dist(harness, "army-officer.agent.md"), join(root, "agents", "army-officer.agent.md")],
      [dist(harness, "army-soldier.agent.md"), join(root, "agents", "army-soldier.agent.md")],
      [dist(harness, "army"), join(root, "skills", "army")],
      [dist(harness, "hooks.json"), join(root, "hooks", "army.json")],
    ]
  }
  const agentToml = (name: string, description: string, body: string, model?: string) =>
    [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(description)}`,
      ...(model ? [`model = ${JSON.stringify(model)}`] : []),
      `developer_instructions = ${tomlString(body)}`,
      "",
    ].join("\n")
  write(dist(harness, "army-officer.toml"), agentToml("army-officer", DESCRIPTIONS.officer, officer))
  write(dist(harness, "army-soldier.toml"), agentToml("army-soldier", DESCRIPTIONS.soldier, soldier, soldierModel))
  write(dist(harness, "army.md"), yaml({ description: DESCRIPTIONS.army, "argument-hint": "<task>" }) + "\n" + army)
  const root = join(home(), ".codex")
  return [
    [dist(harness, "army-officer.toml"), join(root, "agents", "army-officer.toml")],
    [dist(harness, "army-soldier.toml"), join(root, "agents", "army-soldier.toml")],
    [dist(harness, "army.md"), join(root, "prompts", "army.md")],
  ]
}

const hookCommand = (harness: Harness) => ({ type: "command", command: `"${BUN}" "${HOOK}" ${harness}`, timeout: 30 })
const ownsHook = (entry: any) => JSON.stringify(entry).includes("army-hook.ts")

const SPAWN_TOOLS = "^(Agent|Task|spawn_agent)$"
const ARMY_TOOLS = "army_(mobilize|status|wait|check)$"
const ARMY_AGENTS = "^army-(officer|soldier)$"

// Claude Code and Codex share the settings-style hook layout.
export const settingsHooks = (harness: "claude" | "codex") => ({
  PreToolUse: [{ matcher: `${SPAWN_TOOLS}|${ARMY_TOOLS}`, hooks: [hookCommand(harness)] }],
  PostToolUse: [{ matcher: SPAWN_TOOLS, hooks: [hookCommand(harness)] }],
  ...(harness === "claude" ? { PostToolUseFailure: [{ matcher: SPAWN_TOOLS, hooks: [hookCommand(harness)] }] } : {}),
  SubagentStart: [{ matcher: ARMY_AGENTS, hooks: [hookCommand(harness)] }],
  SubagentStop: [{ matcher: ARMY_AGENTS, hooks: [hookCommand(harness)] }],
})

export const copilotHooks = () => {
  const entry = (matcher?: string) => ({ type: "command", exec: BUN, args: [HOOK, "copilot"], timeoutSec: 30, ...(matcher ? { matcher } : {}) })
  return {
    version: 1,
    hooks: {
      PreToolUse: [entry(`Agent|Task|.*${ARMY_TOOLS}`)],
      PostToolUse: [entry("Agent|Task")],
      PostToolUseFailure: [entry("Agent|Task")],
      SubagentStop: [entry()],
    },
  }
}

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {})

const writeJson = (file: string, data: unknown) => {
  if (existsSync(file)) writeFileSync(`${file}.bak-army`, readFileSync(file))
  write(file, JSON.stringify(data, null, 2) + "\n")
}

const mergeHooks = (target: Record<string, any[]>, add: Record<string, any[]>) => {
  for (const [event, entries] of Object.entries(add)) target[event] = [...(target[event] ?? []).filter((e) => !ownsHook(e)), ...entries]
}

const stripHooks = (target: Record<string, any[]> | undefined) => {
  if (!target) return
  for (const event of Object.keys(target)) {
    target[event] = target[event].filter((e) => !ownsHook(e))
    if (target[event].length === 0) delete target[event]
  }
}

const mcpEntry = (harness: Harness) => ({ command: BUN, args: [MCP, harness] })

const tomlBlock = () =>
  [TOML_BEGIN, "[mcp_servers.army]", `command = ${JSON.stringify(BUN)}`, `args = [${JSON.stringify(MCP)}, "codex"]`, TOML_END].join("\n")

const withoutBlock = (text: string) => {
  const rest = text.replace(new RegExp(`${TOML_BEGIN}[\\s\\S]*?${TOML_END}\\n?`, "g"), "").replace(/\n{3,}/g, "\n\n").trimEnd()
  return rest ? `${rest}\n` : ""
}

const configure = (harness: Harness, install: boolean, log: (line: string) => void) => {
  if (harness === "opencode") {
    const file = join(opencodeDir(), "cli.json")
    const pkg = join(opencodeDir(), "plugins", "army-tui")
    const data = readJson(file)
    const has = (data.plugins ?? []).some((p: any) => p.package === pkg)
    if (install && !has) {
      data.plugins = [...(data.plugins ?? []), { package: pkg }]
      writeJson(file, data)
      log(`registered TUI plugin in ${file}`)
    }
    if (!install && has) {
      data.plugins = data.plugins.filter((p: any) => p.package !== pkg)
      writeJson(file, data)
      log(`unregistered TUI plugin from ${file}`)
    }
    return
  }
  if (harness === "claude") {
    const settings = join(home(), ".claude", "settings.json")
    const data = readJson(settings)
    data.hooks ??= {}
    if (install) {
      mergeHooks(data.hooks, settingsHooks("claude"))
      data.env = { ...(data.env ?? {}), CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: data.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? CLAUDE_DEPTH }
    } else {
      stripHooks(data.hooks)
      if (data.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH === CLAUDE_DEPTH) delete data.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
    }
    writeJson(settings, data)
    log(`${install ? "added" : "removed"} army hooks in ${settings}`)
    const mcpFile = join(home(), ".claude.json")
    const mcp = readJson(mcpFile)
    mcp.mcpServers ??= {}
    if (install) mcp.mcpServers.army = { type: "stdio", ...mcpEntry(harness) }
    else delete mcp.mcpServers.army
    writeJson(mcpFile, mcp)
    log(`${install ? "added" : "removed"} army MCP server in ${mcpFile}`)
    return
  }
  if (harness === "copilot") {
    const mcpFile = join(home(), ".copilot", "mcp-config.json")
    const mcp = readJson(mcpFile)
    mcp.mcpServers ??= {}
    if (install) mcp.mcpServers.army = { type: "local", ...mcpEntry(harness), tools: ["*"] }
    else delete mcp.mcpServers.army
    writeJson(mcpFile, mcp)
    log(`${install ? "added" : "removed"} army MCP server in ${mcpFile}`)
    return
  }
  const hooksFile = join(home(), ".codex", "hooks.json")
  const hooks = readJson(hooksFile)
  hooks.hooks ??= {}
  if (install) mergeHooks(hooks.hooks, settingsHooks("codex"))
  else stripHooks(hooks.hooks)
  writeJson(hooksFile, hooks)
  log(`${install ? "added" : "removed"} army hooks in ${hooksFile}`)
  const configFile = join(home(), ".codex", "config.toml")
  const text = existsSync(configFile) ? readFileSync(configFile, "utf8") : ""
  const next = install ? `${withoutBlock(text).trimEnd()}\n\n${tomlBlock()}\n`.replace(/^\n+/, "") : withoutBlock(text)
  if (next !== text) {
    if (existsSync(configFile)) writeFileSync(`${configFile}.bak-army`, text)
    write(configFile, next)
    log(`${install ? "added" : "removed"} army MCP server in ${configFile}`)
  }
}

const isOurLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)).startsWith(REPO + "/")
  } catch {
    return false
  }
}

const link = (src: string, dest: string, log: (line: string) => void) => {
  mkdirSync(dirname(dest), { recursive: true })
  let exists = false
  try {
    lstatSync(dest)
    exists = true
  } catch {}
  if (exists && !lstatSync(dest).isSymbolicLink()) {
    const backup = join(dirname(dest), ".army-backup", STAMP)
    mkdirSync(backup, { recursive: true })
    renameSync(dest, join(backup, dest.split("/").pop()!))
    log(`backed up ${dest} to ${backup}/`)
  } else if (exists) rmSync(dest)
  symlinkSync(src, dest)
  log(`linked ${dest} -> ${src}`)
}

const unlink = (dest: string, log: (line: string) => void) => {
  if (isOurLink(dest)) {
    rmSync(dest)
    log(`removed ${dest}`)
  }
}

// Links installed under older names; removed on install and uninstall.
const legacy = () => [join(opencodeDir(), "commands", "alberts-army.md"), join(binDir(), "alberts-army-status")]

export const install = (harnesses: Harness[], log: (line: string) => void = console.log) => {
  for (const old of legacy()) unlink(old, log)
  link(join(REPO, "bin", "army-status"), join(binDir(), "army-status"), log)
  for (const harness of harnesses) {
    for (const [src, dest] of build(harness)) link(src, dest, log)
    configure(harness, true, log)
  }
}

export const uninstall = (harnesses: Harness[], log: (line: string) => void = console.log) => {
  for (const old of legacy()) unlink(old, log)
  for (const harness of harnesses) {
    for (const [, dest] of build(harness)) unlink(dest, log)
    configure(harness, false, log)
  }
  if (harnesses.length === HARNESSES.length) unlink(join(binDir(), "army-status"), log)
}

export const parseHarnesses = (args: string[]): Harness[] => {
  if (args.length === 0 || args.includes("all")) return [...HARNESSES]
  const bad = args.filter((a) => !HARNESSES.includes(a as Harness))
  if (bad.length) throw new Error(`unknown harness: ${bad.join(", ")} (expected ${HARNESSES.join(", ")}, or all)`)
  return args as Harness[]
}

if (import.meta.main) {
  const [action, ...rest] = process.argv.slice(2)
  const harnesses = parseHarnesses(rest)
  if (action === "install") install(harnesses)
  else if (action === "uninstall") uninstall(harnesses)
  else {
    console.error("usage: setup.ts <install|uninstall> [opencode|claude|copilot|codex|all ...]")
    process.exit(2)
  }
}
