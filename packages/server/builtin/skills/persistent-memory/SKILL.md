---
name: persistent-memory
description: >-
  WebCLI long-term memory (any facts) plus optional encrypted secrets. Use when
  the user asks to remember something, recalls a preference, or when durable
  context / credentials are needed across chats.
---

# Persistent memory & secrets

Two stores under `~/.webcli/` (or `~/.webcli-stand`):

| Store | File | Tool | What belongs here |
|-------|------|------|-------------------|
| **Memory** (default) | `memory.json` | `memory` | **Anything** worth remembering across chats |
| Secrets | `secrets.json` | `secret` | Only passwords / API tokens / private keys |

## memory — general long-term memory

```
memory { action: "list" | "get" | "set" | "delete", key?, value?, tags?, tag? }
```

Use this for **any** durable fact, not just auth:

- Preferences (“prefer Russian”, “headed browser on PC”)
- Decisions & plans (“godot3d is target client”)
- Links & IDs (Meshy workspace URL, model id)
- People / accounts (email as contact — not the password)
- Workflow (“after Texture do Remesh if face explodes”)
- Free-form notes the user says “запомни”

Keys: short dotted names, e.g. `user.lang`, `meshy.last_model`, `elevance.style`.

**When to write:** user says «запомни», «на будущее», repeats a preference, or shares a fact that will matter in later chats.

**When to read:** before asking the user again for something you may already know; at the start of a multi-step task that depends on past choices.

## secret — sensitive only

```
secret { action: "list" | "get" | "set" | "delete", key?, value? }
```

- Passwords, API tokens, refresh tokens the user explicitly wants stored.
- Encrypted with `ACCESS_TOKEN`. Changing it makes old secrets unreadable.
- **Never** paste secret values into chat. Use only to fill forms.
- `list` = keys only.

Prefer Playwright cookie profile (`browser-profiles/default`) for site login sessions; use `secret` when a password must be typed.

## Habits

1. Default store = `memory`. Use `secret` only when the value is sensitive.
2. After «запомни X» → `memory` set, confirm the key briefly.
3. Before re-asking for a known preference → `memory` get / list.
4. Never put secrets in git, board cards, or memory.json.
