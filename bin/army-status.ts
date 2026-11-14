#!/usr/bin/env bun
// Prints OpenCode army trees from saved state, with no model request.
// Usage: army-status [rootSessionID] [--all]   (default: most recently updated army)
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import Army from "../plugin/army.ts"

const dir = join(homedir(), ".local/share/opencode/army")
const args = process.argv.slice(2)
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => join(dir, file))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
const id = args.find((arg) => arg.startsWith("ses_"))
const picked = id ? files.filter((file) => file.endsWith(`${id}.json`)) : args.includes("--all") ? files : files.slice(0, 1)

if (picked.length === 0) {
  console.log("No army runs found.")
  process.exit(id ? 1 : 0)
}
for (const file of picked) console.log(Army.logic.renderTree(JSON.parse(readFileSync(file, "utf8"))))
