#!/usr/bin/env node
// Prints army trees from saved state, with no model request.
// Usage: army-status [rootID] [--all] [--watch]
//   default: runs started in the current repo; the running one, else the most recent
//   --all: every run, from any repo
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readArmies, renderTree, repoOf, type SavedArmy } from "../plugin/army-tui/tree.ts"

const dir = process.env.ARMY_STATE_DIR ?? join(homedir(), ".local/share/opencode/army")
const args = process.argv.slice(2)
const id = args.find((arg) => !arg.startsWith("--"))
const all = args.includes("--all")
const watch = args.includes("--watch")

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const running = ({ army }: SavedArmy) => Object.values(army.nodes).filter((n) => n.status === "running").length

const here = repoOf(process.cwd())

const header = (saved: SavedArmy) => {
  const harness = (saved.army as { harness?: string }).harness ?? "opencode"
  const n = running(saved)
  const where = all ? ` · ${saved.army.repo ?? "unknown repo"}` : ""
  return `[${harness}] updated ${ago(statSync(saved.file).mtimeMs)} · ${n ? `${n} running` : "finished"}${where}`
}

const render = () => {
  const { armies, skipped } = readArmies(dir)
  const lines = skipped.map((line) => `warning: skipped ${line}`)
  const local = armies.filter(({ army }) => army.repo === here)
  const active = local.filter((saved) => running(saved) > 0)
  const picked = id ? armies.filter(({ army }) => army.rootID === id) : all ? armies : active.length ? active : local.slice(0, 1)
  if (picked.length === 0) {
    const empty = id ? `No army run ${id}.` : all ? "No army runs found." : `No army runs in ${here}. Use --all to see runs from every repo.`
    return { text: [...lines, empty].join("\n"), missing: true }
  }
  const note = !id && !all && active.length === 0 ? ["No army is running. Showing the most recent run.", ""] : []
  const trees = picked.map((saved) => `${header(saved)}\n${renderTree(saved.army)}`)
  return { text: [...lines, ...note, trees.join("\n\n")].join("\n"), missing: false }
}

if (watch) {
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H" + render().text + "\n\n(refreshing every 2s, Ctrl-C to stop)\n")
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
const { text, missing } = render()
console.log(text)
process.exit(missing && id ? 1 : 0)
