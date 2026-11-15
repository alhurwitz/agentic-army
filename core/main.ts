// Runtime helpers that work the same under Node and Bun (OpenCode loads the plugin with Bun).
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

// True when the module at `url` is the script being run, not an import.
export const isMain = (url: string) => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}

export const readStdin = async () => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}
