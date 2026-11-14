/** @jsxImportSource @opentui/solid */
import { homedir } from "node:os"
import { join } from "node:path"
import { readArmies, renderTree, repoOf } from "./tree.ts"

// V2 TUI plugin: default export { id, setup }. Commands are registered from an "app" slot,
// the same way the built-in /stats command does it. @opentui/solid is supplied by the host.
const DIR = process.env.ARMY_STATE_DIR ?? join(homedir(), ".local/share/opencode/army")

// Prefer the army this session belongs to (as root or member); else the latest run in this repo.
const statusText = (sessionID: string | undefined) => {
  const { armies, skipped } = readArmies(DIR)
  const list = armies.map(({ army }) => army)
  const here = repoOf(process.cwd())
  const army = list.find((o) => o.rootID === sessionID || (sessionID && o.nodes?.[sessionID])) ?? list.find((o) => o.repo === here)
  const warning = skipped.length ? `\n\nSkipped ${skipped.length} unreadable state file(s).` : ""
  return (army ? renderTree(army) : `No army runs in ${here} yet. Start one with /army <task>.`) + warning
}

export default {
  id: "army-tui",
  setup(t: any) {
    t.ui.slot({
      append: "app",
      render() {
        t.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "army.status",
              title: "Army status",
              description: "Show the agent team tree without a model request",
              group: "Army",
              slash: { name: "army-status" },
              palette: true,
              run() {
                let text: string
                try {
                  text = statusText(t.ui.router.current()?.sessionID)
                } catch (e) {
                  text = `Army status failed: ${e instanceof Error ? e.message : e}`
                }
                t.ui.dialog.show(() => (
                  <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
                    <text>Army Status</text>
                    <text>{text}</text>
                  </box>
                ))
                t.ui.dialog.set?.({ size: "large" })
              },
            },
          ],
        }))
        return null
      },
    })
  },
}
