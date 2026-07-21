---
name: create-project-rule-or-skill
description: >-
  Create or update a project's Cursor rule (.cursor/rules/*.mdc) or skill
  (.cursor/skills/<name>/SKILL.md) when a durable convention or repeatable
  workflow emerges in any repo. Use when capturing lessons, documenting
  project-specific flows, or the user asks to add a rule or skill.
---

# Create project rule or skill

This skill is a **WebCLI built-in** (`packages/server/builtin/skills/…`, synced
to `~/.cursor/skills/…`). Keep the canonical copy in builtin so it applies in
every project. Do **not** move it into a repo or delete it during project
`.cursor/` cleanup.

**Project knowledge** → that repo’s `.cursor/`  
**Product-wide habits** (this file, ask_user, git-init, …) →
`packages/server/builtin/` (synced to `~/.cursor/`)  
**Personal-only habits** → `~/.cursor/` only

## 0. Decide: rule vs skill vs skip

- **Skip** — one-off, speculative, or already covered.
- **Rule** — short “always/never do X in **this** repo”.
- **Skill** — multi-step how-to for tasks that match its `description`.

Search the **current workspace** first:

```text
.cursor/rules/
.cursor/skills/
```

Also glance at `packages/server/builtin/` and `~/.cursor/skills/` /
`~/.cursor/rules/` so you do not duplicate a built-in or personal habit into the
project.

If a close match exists → **edit that file** instead of adding another.

## 1. Project rule (`.cursor/rules/<kebab-name>.mdc`)

```markdown
---
description: >-
  One or two lines: when this rule matters.
alwaysApply: true
---

# Short title

What to do. Point to a skill for long procedures.

## Do not

- Anti-patterns.
```

- `alwaysApply: true` only for small, high-value nudges.
- Long procedures: tiny rule + `See skill \`name\``.

## 2. Project skill (`.cursor/skills/<kebab-name>/SKILL.md`)

```markdown
---
name: kebab-name
description: >-
  What it does and WHEN to use it (verbs/phrases to match on).
---

# Title

## When

…

## Steps

1. …
2. …

## Do not

- …
```

Put RU/EN synonyms in `description` when the user speaks both.

## 3. When something is truly global

Only if it should apply in **every** project (like this skill, `ask-user-interactive`,
`git-init-new-repo`):

- **WebCLI product habit** → `packages/server/builtin/rules/<name>.mdc` or
  `packages/server/builtin/skills/<name>/SKILL.md` (server syncs into `~/.cursor/`)
- **Personal-only** (not shipping with the app) → `~/.cursor/rules/` or
  `~/.cursor/skills/`

Otherwise default to **project-local**.

## 4. After writing

1. Save the file (commit only if the user asked).
2. Tell the user the path and one-line purpose.
3. If you wrote under `packages/server/builtin/`, sync/copy into `~/.cursor/`
   (or restart/promote so `syncBuiltinConfigToUser` runs).

## 5. Update or delete (project files only)

- **Edit** in place when the workflow changes.
- **Delete** obsolete **project** rules/skills.
- Merge overlaps; ask with `ask_user` before deleting something that looks
  user-authored and unfamiliar.
- **Never** delete or “clean up” built-ins under `packages/server/builtin/` or
  their synced copies under `~/.cursor/` unless the user explicitly asks.

## Do not

- Copy this skill into a project “for convenience”.
- Create empty stubs “for later”.
- Put secrets or brittle machine-only paths in shared rules/skills.
- Leave contradictory rules — fix or delete the project ones.
