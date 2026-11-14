#!/usr/bin/env bun
// Prints army trees from saved state, with no model request.
// Usage: army-status [rootSessionID] [--all]   (default: most recently updated army)
import { homedir } from "node:os"
import { join } from "node:path"
import { readArmies, renderTree } from "../plugin/army-tui/tree.ts"

const dir = process.env.ARMY_STATE_DIR ?? join(homedir(), ".local/share/opencode/army")
const args = process.argv.slice(2)
const { armies, skipped } = readArmies(dir)
for (const line of skipped) console.error(`warning: skipped ${line}`)

const id = args.find((arg) => arg.startsWith("ses_"))
const picked = id ? armies.filter(({ army }) => army.rootID === id) : args.includes("--all") ? armies : armies.slice(0, 1)

if (picked.length === 0) {
  console.log(id ? `No army run ${id}.` : "No army runs found.")
  process.exit(id ? 1 : 0)
}
console.log(picked.map(({ army }) => renderTree(army)).join("\n\n"))
