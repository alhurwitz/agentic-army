#!/usr/bin/env node
// Minimal stdio MCP server exposing army_mobilize, army_status, army_wait, and army_check to
// harnesses without an in-process plugin API. The army hook adds `_caller` (the calling agent's
// id chain) to each call; without it the server cannot tell who is asking and refuses.
import { isMain } from "../core/main.ts"
import { createInterface } from "node:readline"

import * as engine from "../core/engine.ts"

const NAME = "army"
const VERSION = "0.2.0"
const CALLER = {
  type: "array",
  items: { type: "string" },
  description: "Filled in automatically by the army hook. Leave empty.",
}

const tools = Object.entries(engine.TOOL_SCHEMAS).map(([name, schema]) => ({
  name,
  description: engine.TOOL_DOCS[name as keyof typeof engine.TOOL_DOCS],
  inputSchema: { type: "object", properties: { ...(schema as any).properties, _caller: CALLER, _cwd: { type: "string", description: "Filled in automatically by the army hook. Leave empty." } }, required: (schema as any).required ?? [] },
}))

const harness = process.argv[2]

export const callTool = async (name: string, args: any): Promise<string> => {
  if (name === "army_check") return engine.check(String(args?.worktree ?? ""))
  const chain: string[] = Array.isArray(args?._caller) ? args._caller.filter((id: unknown) => typeof id === "string" && id) : []
  if (chain.length === 0) return "army hook not installed for this tool, so the caller is unknown. Run the agentic-army install.sh for this harness."
  if (name === "army_mobilize") return engine.mobilize(chain, { maxDepth: args?.maxDepth, maxAgents: args?.maxAgents }, harness, typeof args?._cwd === "string" ? args._cwd : process.cwd())
  if (name === "army_status") return engine.statusText(chain)
  if (name === "army_wait") return engine.wait(chain, args?.mode === "all" ? "all" : "any", Number(args?.timeoutMinutes ?? 30) * 60_000)
  throw new Error(`unknown tool ${name}`)
}

const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
const fail = (id: unknown, code: number, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")

export const dispatch = async (message: any) => {
  const { id, method, params } = message
  if (id === undefined) return
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    })
  }
  if (method === "ping") return reply(id, {})
  if (method === "tools/list") return reply(id, { tools })
  if (method === "tools/call") {
    try {
      const text = await callTool(params?.name, params?.arguments ?? {})
      return reply(id, { content: [{ type: "text", text }] })
    } catch (error: any) {
      return reply(id, { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true })
    }
  }
  return fail(id, -32601, `method not found: ${method}`)
}

if (isMain(import.meta.url)) {
  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    if (!line.trim()) return
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return fail(null, -32700, "parse error")
    }
    void dispatch(message)
  })
}
