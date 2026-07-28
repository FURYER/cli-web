---
name: delegate-subagents
description: >-
  Delegate work to isolated sub-agents (git worktree + branch each), review
  results, and merge back. Use when parallel isolated work would help — judge
  the tradeoff yourself. RU: делегирование, саб-агент, worktree, merge_child.
---

# Sub-agents (delegate_task)

When to use (short nudge): built-in rule `delegate-subagents`. This skill is the
**how-to**. Prefer calling these tools over inventing markdown “todo lists” that
pretend to be parallel.

## Tools

### `delegate_task`
Creates a **git worktree + branch** for a child chat and starts the agent there.

```
delegate_task({
  title: "Auth API",
  prompt: "Implement … (concrete acceptance criteria)",
  wait: false,
  wake_on_done: false
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
- `wake_on_done: true` — when **this** child finishes, wake you immediately even
  if siblings are still running. Mark as many children as you need this way.
  Default `false` waits until the whole parallel batch is idle.
- Child cwd is an isolated worktree under the host data dir; branch is `webcli/agent/<id>`.

### `wake_on_child_done`
Toggle early-wake on an existing child (same effect as `wake_on_done` at spawn).

```
wake_on_child_done({ childSessionId: "…", enabled: true })
```

If the child already finished and `enabled: true`, queues an early wake now.
`enabled: false` returns that child to batch wake.

### `get_child_result`
Review status, last assistant message, and `git log`/`diff --stat` vs base.

### `merge_child`
Merges the child branch into the **parent** workspace, then removes the worktree.

On **conflict**: resolve files in the parent repo (or `git merge --abort`), then retry.

## Recommended flow

1. Decide the split is worth it (see rule `delegate-subagents`).
2. `delegate_task` × N with `wait: false` (each call auto-prepares if still dirty).
3. For children whose result you need ASAP (unblock merge / next step), set
   `wake_on_done: true` (or call `wake_on_child_done` later).
4. **You can end your turn** — the system wakes you when those early children
   finish (and again when the remaining batch is idle, if any).
5. In a wake-up turn: `merge_child` in a sensible order (independent first).
6. If conflict → ask the user with `ask_user`, then continue.

(`wait: true` still works for a single sequential child; that path does **not**
auto-wake because you already get the result in the tool response.)

## Constraints

- Only the **orchestrator** (top-level chat) may call these tools — children cannot nest further.
- Parent must be a **git repository**.
- Keep secrets out of the tree (`.env` etc. should stay gitignored) — checkpoints use `git add -A`.
- Always give children a crisp prompt with file boundaries and done criteria.
