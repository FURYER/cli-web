---
name: promote-web-cli-release
description: >-
  Ship WebCLI changes to the live release on :8787. Use when the user asks to
  restart the web app, promote to release, выкатить, задеплоить, or after you
  finish server/UI changes that must appear in the phone/browser release (not
  only the stand).
---

# Promote WebCLI to release

Release (`:8787`, phone/CloudPub) does **not** hot-reload. After you change
code under this repo that the user should see in the live WebCLI, **you**
promote — do not tell the user to restart manually.

## What to run

From the repo root:

```bat
promote-to-release.bat
```

That builds (`npm run build`) while release keeps serving, then schedules a
restart via `POST /api/admin/deploy`. The UI shows a banner; the page reloads
when the new process is up.

Requires release already running via `start-prod.bat` (restart loop). CloudPub
on `:8787` stays up across promote.

## Busy chat = restart waits

Promote waits until **no agent run is busy**. This chat’s own run counts as
busy. Therefore:

1. Run `promote-to-release.bat` as the **last** action of the turn.
2. Confirm schedule succeeded (exit 0 / “Scheduled…”).
3. **Stop** — do not poll for restart, do not start long follow-up work.
4. When this run ends, idle triggers restart. That is expected.

If the user interrupts or sends a short “ок” after schedule, that also clears
busy and lets restart proceed — fine.

Do **not** leave a long `Wait-Done` / health poll loop running after schedule;
that keeps the session busy and blocks the restart.

## Stand vs release

| | Stand | Release |
|--|--|--|
| Ports | `:8788` / Vite `:5174` | `:8787` |
| Start | `start-stand.bat` | `start-prod.bat` |
| Reload | hot reload while coding | `promote-to-release.bat` |
| Data | `~/.webcli-stand` | `~/.webcli` |

Use the stand for iterative feature work. Promote when the user wants the
change on the phone/release UI, or when they say restart/выкатить/promote.

## Do not

- Say “перезапусти сам” / “run start-prod” when promote would work.
- Kill `:8787` with `taskkill` unless promote/API is broken and the user asked.
- Promote on every tiny stand-only experiment without being asked — but **do**
  promote when they ask to restart the web app or see the fix in release.
