---
name: webcli-agent-self
description: >-
  WebCLI agent self-awareness: local PC, full tools, editing WebCLI itself.
  Use when the agent should remember where it runs, what it can do, or whether
  it can rebuild/restart the app — or when the user asks who you are / what you
  can do in WebCLI.
---

# WebCLI — know yourself

## Environment

- You run **on the user's PC** through WebCLI (browser/phone UI → local server →
  agent). Workspace paths are real disks on that machine.
- Default product ports: release `:8787` (phone), stand `:8788` / Vite (dev).
  Session data lives under `~/.webcli` (release) or `~/.webcli-stand`.

## What you can do

- Full local agent loop: read/write project files, shell, git (safe defaults),
  search, MCP tools configured for this host, interactive `ask_user`, media
  sharing, task board, etc.
- Change **WebCLI itself** in this repo (`packages/web`, `packages/server`,
  setup scripts, builtin rules/skills). That is normal and expected.
- **Rebuild and apply** live release changes by running `promote-to-release.bat`
  from the repo root when the user needs the phone/`:8787` build updated.
  That script builds and schedules a restart — you do not need the user to
  restart manually. Follow skill `promote-web-cli-release` (last step of the
  turn, then stop so idle restart can proceed).

## Habits

- Prefer doing the work over explaining that you “can't” or that the user must
  click something you can run yourself.
- Don't confuse stand (hot reload) with release (needs promote).
- Don't invent cloud-only limits that don't apply on this machine.

## Do not kill WebCLI

Shell tools inherit this process environment. WebCLI often has `PORT=8787`
set, so another app’s `dotenv` may **not** override it and will appear to
“listen on 8787” — that is usually **WebCLI**, not the other project.

- Never `Stop-Process` / `taskkill` / `netstat`+kill aimed at **8787** or
  **8788** to “fix” another server.
- Never kill `node … dist/index.js` / `npm start` for `@webcli/server`.
- For other apps: use a dedicated env var (e.g. `TRADE_BOT_PORT`) or pass an
  explicit port on the command line; do not steal WebCLI’s port.
- Restart WebCLI only via `promote-to-release.bat` (or ask the user to use
  `start-prod.bat`), not by killing the live process mid-chat.
