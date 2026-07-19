---
name: delegate-subagents
description: >-
  Delegate work to isolated sub-agents (git worktree + branch each), review
  results, and merge back. Use for parallelizable tasks that may touch the
  same files.
---

# Sub-agents (delegate_task)

When a large task can be split, or multiple agents should edit overlapping
areas safely, use the in-process tools — **do not** invent markdown checklists
instead of calling them.

## Tools

### `delegate_task`
Creates a **git worktree + branch** for a child chat and starts the agent there.

```
delegate_task({
  title: "Auth API",
  prompt: "Implement … (concrete acceptance criteria)",
  wait: false
})
```

**Before spawn, the system prepares the parent:**

1. Must be a **git repository** with a resolvable `HEAD`.
2. Must **not** be mid-merge / rebase / cherry-pick / revert.
3. If the working tree is **dirty** (modified or untracked), WebCLI creates a
   checkpoint commit: `webcli: checkpoint before delegate`.
4. Then the child worktree is forked from that `HEAD`.

So you do **not** need a separate prepare step — just call `delegate_task`.
If prepare fails, fix the git state (init/commit, or abort the in-progress
operation) and retry. The tool result includes a `prepare` object
(`checkpointCreated`, `filesCommitted`, `headSha`).

- `wait: false` (default) — runs in parallel; returns `childSessionId` immediately.
- `wait: true` — blocks until that child finishes (simpler sequential flow).
- Child cwd is an isolated worktree under the host data dir; branch is `webcli/agent/<id>`.

### `get_child_result`
Review status, last assistant message, and `git log`/`diff --stat` vs base.

### `merge_child`
Merges the child branch into the **parent** workspace, then removes the worktree.

On **conflict**: resolve files in the parent repo (or `git merge --abort`), then retry.

## Recommended flow

1. Plan the split (non-overlapping preferred; overlapping is OK because of worktrees).
2. `delegate_task` × N with `wait: false` (each call auto-prepares if still dirty).
3. **You can end your turn** — when all those children finish, the system
   automatically sends you a wake-up message with their results.
4. In that wake-up turn: `merge_child` in a sensible order (independent first).
5. If conflict → ask the user with `ask_user`, then continue.

(`wait: true` still works for a single sequential child; that path does **not**
auto-wake because you already get the result in the tool response.)

## Rules

- Only the **orchestrator** (top-level chat) may call these tools — children cannot nest further.
- Parent must be a **git repository**.
- Keep secrets out of the tree (`.env` etc. should stay gitignored) — checkpoints use `git add -A`.
- Always give children a crisp prompt with file boundaries and done criteria.
