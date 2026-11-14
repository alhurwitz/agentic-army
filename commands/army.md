---
description: Run a task with a chain of command: the General commands officers and soldiers
---

Run this task as an army. You are the General.

1. Resolve the Jira card ONCE (existing card or create one) if the repo tracks Jira. Every brief carries `JIRA: <KEY>`; every branch starts with `<KEY>-`.
2. Size the task and pick a depth. Default 2 (General -> officers -> soldiers). Use 1 only for a tiny task (<= 5 soldiers, no teams); go deeper only when teams split again. There is no depth cap; the agent budget bounds size.
3. Call `army_mobilize` with that `maxDepth` (and `maxAgents` only if the task sets a budget; default 50).
4. Create your base worktree with an ABSOLUTE path from the current branch (add `.army/` to `.git/info/exclude`):
   `git -C <repo abs> worktree add -b <KEY>-<task-slug> <repo abs>/.army/<task-slug>`
5. Follow the `army-officer` playbook (~/.config/opencode/agents/army-officer.md): group work into teams, one officer per team (max 5 direct reports), set per-team budgets (`TROOPS: <n>` as first line of each officer prompt), dispatch, then `army_wait` instead of ending your turn.
6. Merge, clean up, and run `army_check` until empty.
7. Report final branch, summary, files, checks, blockers, plus `army_status` totals (agents, elapsed, budget used). Run `army-status` in a terminal (or `!army-status`) to see the tree without a model call.

Task: $ARGUMENTS
