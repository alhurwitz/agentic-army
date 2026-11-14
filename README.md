# agentic-army

Chain-of-command multi-agent orchestration for [OpenCode](https://opencode.ai): General → officers → soldiers, with enforced budgets and per-agent git worktrees.

## How it works

- **General**: the root session. Runs `/army <task>`, calls `army_mobilize`, and commands officers.
- **Officers** (`army-officer`): plan a team's work, delegate to soldiers (or sub-officers), merge their branches, and report up. They never edit code.
- **Soldiers** (`army-soldier`): do one scoped unit of work in their own git worktree, commit it, and report to their officer.

The plugin enforces the structure:

| Rule | Enforcement |
| --- | --- |
| Depth | At most `maxDepth` levels below the General (no fixed cap; `maxAgents` bounds total size); the leaf level is soldiers only. |
| Chain of command | With `maxDepth >= 2`, the General spawns officers only. Untracked sessions cannot command troops. |
| Promotion | A soldier that spawns is promoted to officer and borrows the spawn cost from its parent's budget. |
| Span of control | At most 5 running direct reports per commander. |
| Budget | Every officer prompt starts with `TROOPS: <n>`; an officer costs `1 + n`, a soldier costs 1. Unused budget returns to the parent. Non-army helpers the General spawns (e.g. `explore`) are not counted. |
| Isolation | Each child gets its own worktree under `<parent worktree>/.army/<slug>` on branch `<parent branch>-<slug>`. |

Tools added to the session: `army_mobilize`, `army_status`, `army_wait`, `army_check`.

## Install

Requires [Bun](https://bun.sh) and OpenCode.

```sh
git clone https://github.com/alhurwitz/agentic-army
cd agentic-army
./install.sh
```

`install.sh` checks for Bun, OpenCode and git, runs the tests, then symlinks the plugin, agents, and command into `~/.config/opencode` (override with `OPENCODE_CONFIG_DIR`) and the status CLI into `~/.local/bin` (override with `ARMY_BIN_DIR`). Existing non-symlink files are moved to `~/.config/opencode/.army-backup/<timestamp>/`.

Uninstall:

```sh
./uninstall.sh           # remove links that point into this repo
./uninstall.sh --purge   # also delete saved run state
```

## Usage

```
/army <task>
```

Check a run without a model call:

```sh
army-status            # latest run
army-status ses_...    # a specific run
army-status --all
```

Run state is stored in `~/.local/share/opencode/army/` (override with `ARMY_STATE_DIR`).

## Layout

```
plugin/army.ts        plugin: tools + spawn enforcement
plugin/army-tui/      TUI plugin and tree renderer
agents/               army-officer and army-soldier playbooks
commands/             /army command
bin/army-status.ts    status CLI
tests/                bun tests
```

## Development

```sh
bun test tests
```
