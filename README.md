# agentic-army

Chain-of-command multi-agent orchestration for [OpenCode](https://opencode.ai), [Claude Code](https://code.claude.com), [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), and [Codex](https://developers.openai.com/codex): General → officers → soldiers, with enforced budgets and per-agent git worktrees.

## How it works

- **General**: the root session. Runs `/army <task>`, calls `army_mobilize`, and commands officers.
- **Officers** (`army-officer`): plan a team's work, delegate to soldiers (or sub-officers), merge their branches, and report up. They never edit code.
- **Soldiers** (`army-soldier`): do one scoped unit of work in their own git worktree, commit it, and report to their officer.

Every spawn is checked against these rules:

| Rule | Enforcement |
| --- | --- |
| Depth | At most `maxDepth` levels below the General: default 5, any larger value on request (`maxAgents` bounds total size); the leaf level is soldiers only. |
| Chain of command | With `maxDepth >= 2`, the General spawns officers only. Untracked sessions cannot command troops. |
| Promotion | A soldier that spawns is promoted to officer and borrows the spawn cost from its parent's budget. |
| Span of control | At most 5 running direct reports per commander. |
| Budget | Every officer prompt starts with `TROOPS: <n>`; an officer costs `1 + n`, a soldier costs 1. Unused budget returns to the parent. Non-army helpers the General spawns (e.g. `explore`) are not counted. |
| Isolation | Each child gets its own worktree under `<parent worktree>/.army/<slug>` on branch `<parent branch>-<slug>`. |

Tools: `army_mobilize`, `army_status`, `army_wait`, `army_check`.

## Harness support

| Harness | Enforcement | Army tools | Agents and command |
| --- | --- | --- | --- |
| OpenCode | in-process plugin | plugin tools | `~/.config/opencode/agents`, `/army` command, TUI `/army-status` |
| Claude Code | hooks in `~/.claude/settings.json` | MCP server in `~/.claude.json` | `~/.claude/agents`, `/army` command |
| Copilot CLI | hooks in `~/.copilot/hooks/army.json` | MCP server in `~/.copilot/mcp-config.json` | `~/.copilot/agents`, `army` skill |
| Codex | hooks in `~/.codex/hooks.json` | MCP server in `~/.codex/config.toml` | `~/.codex/agents`, `/army` prompt |

Notes:

- Claude Code limits nesting to 3 subagent layers by default. The installer sets `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=20` (unless you already set it) so the army's own `maxDepth` decides.
- Codex asks you to review new hooks: open `/hooks` and trust the army hooks after installing. Codex ignores symlinked agent files, so its agents are copied (re-run `./install.sh codex` after pulling). Codex encrypts spawn messages, so officers get their budget from a `_troops_<n>` suffix on `task_name`, and children get the army preamble at start-up.
- The hooks pass the caller's identity to the army MCP tools. Without the hooks, the MCP tools refuse to run.
- Hooks fail open: if the hook command crashes, the tool call goes ahead. Only rule violations are blocked.

## Install

Requires git and at least one harness. Uses [Bun](https://bun.sh) if installed, otherwise the Bun runtime bundled inside OpenCode (`opencode` on PATH); one of the two is needed.

```sh
git clone https://github.com/alhurwitz/agentic-army
cd agentic-army
./install.sh                    # every harness found on PATH
./install.sh claude codex       # or pick: opencode, claude, copilot, codex, all
```

`install.sh` runs the tests, renders the playbooks for each harness into `dist/`, symlinks them into the harness config, and adds the hooks and MCP server entries. Existing files it would replace are moved to `.army-backup/<timestamp>/` next to them; edited JSON configs get a `.bak-army` copy. The status CLI is linked into `~/.local/bin` (override with `ARMY_BIN_DIR`). Set `OPENCODE_CONFIG_DIR` to use a different OpenCode config dir, and `ARMY_<HARNESS>_SOLDIER_MODEL` (e.g. `ARMY_OPENCODE_SOLDIER_MODEL`) to pin the soldier agent's model for one harness.

Uninstall:

```sh
./uninstall.sh                  # all harnesses
./uninstall.sh claude           # one harness
./uninstall.sh --purge          # also delete saved run state
```

Uninstall removes only links into this repo and the config entries the installer added; your own hooks and servers stay.

## Usage

```
/army <task>
/army depth 8: <task>    # ask for a deeper chain
```

In Copilot CLI, ask to "run this as an army" (the `army` skill).

Check a run without a model call:

```sh
army-status            # latest run
army-status <rootID>   # a specific run
army-status --all
```

Run state is stored in `~/.local/share/opencode/army/` (override with `ARMY_STATE_DIR`), one JSON file per run, shared by every harness and guarded by a lock.

## Layout

```
core/rules.ts          rules and budget accounting (pure)
core/store.ts          run state on disk with a cross-process lock
core/engine.ts         harness-neutral operations (mobilize, spawn, bind, end, wait, check)
plugin/army.ts         OpenCode adapter (tools + spawn hooks)
plugin/army-tui/       OpenCode TUI plugin and tree renderer
bin/army-hook.ts       hook command for Claude Code, Copilot CLI, Codex
bin/army-mcp.ts        stdio MCP server with the army tools
bin/army-status.ts     status CLI
playbooks/             officer, soldier, and /army playbooks (rendered per harness)
scripts/setup.ts       install/uninstall logic
tests/                 bun tests
```

## Development

```sh
bin/army-run test tests
```
