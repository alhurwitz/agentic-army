// Shared by the army server plugin and the army-tui terminal plugin. Keep dependency-free.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export type TreeNode = {
  sessionID: string
  parentID: string
  agent?: string
  description: string
  status: string
  startedAt: number
  endedAt?: number
  budget: number
  used: number
}
export type TreeOrg = {
  rootID: string
  maxDepth: number
  maxAgents: number
  spawned: number
  officers: number
  ics: number
  used: number
  nodes: Record<string, TreeNode>
}

const MANAGER = "army-officer"
type Node = TreeNode
type Army = TreeOrg

export const elapsed = (node: Node, now: number) => {
  const seconds = Math.max(0, Math.round(((node.endedAt ?? now) - node.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

export const childrenOf = (army: Army, parentID: string) =>
  Object.values(army.nodes)
    .filter((node) => node.parentID === parentID)
    .sort((a, b) => a.startedAt - b.startedAt)

const renderNode = (army: Army, node: Node, now: number, indent: string): string[] => {
  const role = node.agent === MANAGER ? "officer" : "soldier"
  const budget = node.agent === MANAGER ? `, budget ${node.used}/${node.budget}` : ""
  const line = `${indent}- ${role} "${node.description}" ${node.status} ${elapsed(node, now)}${budget} [${node.sessionID}]`
  return [line, ...childrenOf(army, node.sessionID).flatMap((child) => renderNode(army, child, now, `${indent}  `))]
}

export const renderTree = (army: Army, now = Date.now()) => {
  const nodes = Object.values(army.nodes)
  const running = nodes.filter((node) => node.status === "running").length
  return [
    `General ${army.rootID} (maxDepth ${army.maxDepth}): root budget ${army.used}/${army.maxAgents}`,
    ...childrenOf(army, army.rootID).flatMap((child) => renderNode(army, child, now, "  ")),
    `Totals: spawned ${army.spawned}/${army.maxAgents} (officers ${army.officers}, soldiers ${army.ics}); running ${running}.`,
  ].join("\n")
}


export type SavedArmy = { file: string; army: TreeOrg }

// Reads saved army runs, newest first. Unreadable or malformed files are reported, not thrown.
export const readArmies = (dir: string): { armies: SavedArmy[]; skipped: string[] } => {
  const armies: SavedArmy[] = []
  const skipped: string[] = []
  if (!existsSync(dir)) return { armies, skipped }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
  const mtime = new Map(files.map((file) => [file, statSync(file).mtimeMs]))
  for (const file of files.sort((a, b) => mtime.get(b)! - mtime.get(a)!)) {
    try {
      const army = JSON.parse(readFileSync(file, "utf8"))
      if (!army || typeof army.rootID !== "string" || typeof army.nodes !== "object") throw new Error("not an army state file")
      armies.push({ file, army })
    } catch (error) {
      skipped.push(`${file}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return { armies, skipped }
}
