// Run state on disk: one JSON file per army, guarded by a lock directory so separate
// processes (OpenCode plugin, hook commands, MCP servers) can read-modify-write safely.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { readArmies } from "../plugin/army-tui/tree.ts"
import type { Army } from "./rules.ts"

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 10_000

export const stateDir = () => process.env.ARMY_STATE_DIR ?? join(homedir(), ".local", "share", "opencode", "army")

const fileOf = (rootID: string) => join(stateDir(), `${rootID.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`)

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export const writeAtomic = (file: string, data: string) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

const lock = (file: string) => {
  const dir = `${file}.lock`
  const start = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dir)
      return () => rmSync(dir, { recursive: true, force: true })
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) rmSync(dir, { recursive: true, force: true })
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`[army] timed out waiting for lock ${dir}`)
      sleep(Math.min(5 * 2 ** attempt, 100))
    }
  }
}

export const readArmy = (rootID: string): Army | undefined => {
  try {
    return { pending: {}, ...JSON.parse(readFileSync(fileOf(rootID), "utf8")) }
  } catch {
    return undefined
  }
}

export const listArmies = (): Army[] => readArmies(stateDir()).armies.map(({ army }) => ({ pending: {}, ...army }) as Army)

// Runs fn on the latest saved army under the lock and saves it if fn returns true.
export const withArmy = <T>(rootID: string, fn: (army: Army | undefined) => { save?: Army; result: T }): T => {
  mkdirSync(stateDir(), { recursive: true })
  const file = fileOf(rootID)
  const release = lock(file)
  try {
    const { save, result } = fn(readArmy(rootID))
    if (save) writeAtomic(file, JSON.stringify(save, null, 2))
    return result
  } finally {
    release()
  }
}
