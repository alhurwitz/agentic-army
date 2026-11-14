#!/usr/bin/env bun
// Hook command for harnesses that enforce the army through lifecycle hooks (Claude Code,
// GitHub Copilot CLI, Codex). Usage: army-hook <claude|copilot|codex>, JSON event on stdin.
// Fails open: an unexpected error never blocks the user's tool call.
import { randomUUID } from "node:crypto"

import * as engine from "../core/engine.ts"

type Harness = "claude" | "copilot" | "codex"
type Out = Record<string, unknown> | undefined

const AGENT_TOOLS = new Set(["Agent", "Task", "task", "spawn_agent"])
const ARMY_TOOL = /army_(mobilize|status|wait|check)$/
const TYPE_FIELDS = ["subagent_type", "agent_type", "agent", "agent_name", "agentName", "name"]
const PROMPT_FIELDS = ["prompt", "message", "task", "instructions"]

const pick = (input: any, fields: string[]) => fields.find((field) => typeof input?.[field] === "string")

// Finds a child agent id in a tool response of unknown shape.
export const findAgentID = (value: any): string | undefined => {
  if (!value) return undefined
  if (typeof value === "string") {
    try {
      return findAgentID(JSON.parse(value))
    } catch {
      return /\bagent[_ ]?id["':=\s]+([A-Za-z0-9_-]{6,})/i.exec(value)?.[1]
    }
  }
  if (typeof value !== "object") return undefined
  for (const key of ["agentId", "agent_id", "agentID"]) if (typeof value[key] === "string") return value[key]
  for (const nested of Object.values(value)) {
    const found = findAgentID(nested)
    if (found) return found
  }
  return undefined
}

export const normalize = (raw: any) => ({
  event: String(raw.hook_event_name ?? raw.hookEventName ?? ""),
  sessionID: String(raw.session_id ?? raw.sessionId ?? ""),
  agentID: raw.agent_id ?? raw.agentId,
  agentType: raw.agent_type ?? raw.agentType ?? raw.agent_name ?? raw.agentName,
  parentAgentID: raw.parent_agent_id ?? raw.parentAgentId,
  toolName: String(raw.tool_name ?? raw.toolName ?? ""),
  toolInput: raw.tool_input ?? raw.toolArgs ?? {},
  toolUseID: raw.tool_use_id ?? raw.toolUseId,
  toolResponse: raw.tool_response ?? raw.tool_result ?? raw.toolResult,
})

type Event = ReturnType<typeof normalize>

const chainOf = (e: Event) => [e.agentID, e.parentAgentID, e.sessionID].filter((id): id is string => Boolean(id))

const deny = (harness: Harness, reason: string): Out =>
  harness === "copilot"
    ? { permissionDecision: "deny", permissionDecisionReason: `[army] BLOCKED: ${reason}` }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[army] BLOCKED: ${reason}` } }

const rewrite = (harness: Harness, input: Record<string, unknown>): Out =>
  harness === "copilot"
    ? { permissionDecision: "allow", modifiedArgs: input }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: input } }

export const handle = (harness: Harness, raw: any): Out => {
  const e = normalize(raw)
  const input = typeof e.toolInput === "object" && e.toolInput ? (e.toolInput as Record<string, any>) : {}

  // First sight of an army child the harness did not report at spawn time: bind it now so its own
  // spawns and its stop event resolve to the right node.
  if (e.agentID && e.agentType && e.event !== "SubagentStart") engine.bindByType([e.sessionID], e.agentID, e.agentType, e.parentAgentID)

  if (e.event === "PreToolUse" && ARMY_TOOL.test(e.toolName)) {
    return rewrite(harness, { ...input, _caller: chainOf(e) })
  }

  if (e.event === "PreToolUse" && AGENT_TOOLS.has(e.toolName)) {
    const typeField = pick(input, TYPE_FIELDS)
    const promptField = pick(input, PROMPT_FIELDS)
    const decision = engine.requestSpawn({
      chain: chainOf(e),
      child: typeField ? input[typeField] : "",
      prompt: promptField ? input[promptField] : "",
      description: String(input.description ?? ""),
      key: e.toolUseID ?? randomUUID(),
    })
    if (decision.error) return deny(harness, decision.error)
    if (decision.prompt === undefined || !promptField) return undefined
    return rewrite(harness, { ...input, [promptField]: decision.prompt })
  }

  if (e.event === "PostToolUse" && AGENT_TOOLS.has(e.toolName) && e.toolUseID) {
    const childID = findAgentID(e.toolResponse)
    if (childID) engine.bindSpawn(e.toolUseID, childID)
    return undefined
  }

  if (e.event === "PostToolUseFailure" && AGENT_TOOLS.has(e.toolName) && e.toolUseID) {
    engine.failSpawn(e.toolUseID)
    return undefined
  }

  if (e.event === "SubagentStart" && e.agentID && e.agentType) {
    engine.bindByType([e.sessionID], e.agentID, e.agentType, e.parentAgentID)
    return undefined
  }

  if (e.event === "SubagentStop" && e.agentID) {
    engine.ended(e.agentID, "done")
    // Codex requires JSON on stdout for SubagentStop.
    return harness === "codex" ? {} : undefined
  }

  return undefined
}

if (import.meta.main) {
  const harness = process.argv[2] as Harness
  try {
    if (!["claude", "copilot", "codex"].includes(harness)) throw new Error(`unknown harness "${harness}"`)
    const raw = JSON.parse(await Bun.stdin.text())
    const out = handle(harness, raw)
    if (out) process.stdout.write(JSON.stringify(out))
  } catch (error: any) {
    process.stderr.write(`[army] hook error (ignored): ${error?.message ?? error}\n`)
  }
  process.exit(0)
}
