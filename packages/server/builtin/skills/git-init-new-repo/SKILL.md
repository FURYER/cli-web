---
name: git-init-new-repo
description: >-
  When creating a new project/repository folder (e.g. under Documents/GitHub),
  always run git init (and usually an initial commit). Use whenever scaffolding
  a new repo, MCP server, or greenfield project directory.
---

# Git init for new repositories

When you **create a new repository directory** (not a subfolder inside an
existing git project):

1. Create the folder and files as needed.
2. **Immediately** run `git init` in that folder.
3. Add a sensible `.gitignore` (node_modules, dist, .env, …).
4. Prefer an **initial commit** so the repo has a real history from day one
   (`git add` + `git commit`) — unless the user said not to commit.

## Why

Without `git init`, there is no version control, no safe rollback, and tools
that expect a git root (Cursor, hooks, release scripts) break or behave oddly.

## Do not

- Skip `git init` because “we can do it later”.
- Run `git init` inside an already-tracked subdirectory of another repo
  (nested repos) unless the user explicitly wants a separate repo.
- Change global git config (`user.name` / `user.email`).
