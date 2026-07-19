# WebCLI

Local chat UI for a coding agent on your PC. Open it in a browser or on your phone. The agent runs on your machine against a local workspace. Today the backend is [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript); the product itself is agent-agnostic. Expose the app with [CloudPub](https://cloudpub.ru) for remote HTTPS access.

## Two environments

| | **Release** (you / phone) | **Test stand** (feature work) |
|--|--|--|
| Start (local) | `start-prod.bat` | `start-stand.bat` or `npm run stand` |
| Start (phone) | `start-prod.bat` | `start-stand-prod.bat` |
| CloudPub | `publish-release.bat` → `:8787` | `publish-stand.bat` → `:8788` |
| UI | `http://127.0.0.1:8787` | local `:5174` / phone `:8788` |
| Data | `%USERPROFILE%\.webcli\` | `%USERPROFILE%\.webcli-stand\` |
| Reload | `promote-to-release.bat` (idle restart) | hot reload (`start-stand.bat`) |

They share the same git tree and `.env` (`AGENT_API_KEY`, `ACCESS_TOKEN`), but **not** ports, session/push storage, or CloudPub URLs. Two `clo publish` tunnels can run at once — one per port.

On first start, if `~/.cursor-cli` still exists and `~/.webcli` does not, WebCLI renames it automatically (same for `-stand` and workspace `.cursor-cli/board.json` → `.webcli/board.json`). Legacy env names (`CURSOR_API_KEY`, `CURSOR_CLI_*`) are still accepted.

### Promote stand → release (without killing the chat)

Release must be running via `start-prod.bat` (restart loop). One-time: if your release was started with an older script, restart `start-prod.bat` once so it picks up the loop + deploy API.

```bat
rem After the feature looks good on the stand:
promote-to-release.bat
```

What happens:

1. `npm run build` while release keeps serving
2. Schedules a restart as soon as no agent run is busy
3. UI shows a banner while waiting (Cancel available); page reloads after the new process is up
4. If still busy, waits for idle (up to +30 min), then exits with code `75`
5. `start-prod.bat` loop starts the new process — CloudPub on `:8787` stays up

Sessions in `%USERPROFILE%\.webcli\` survive the brief reconnect.

## Requirements

- Node.js 22+
- `AGENT_API_KEY` — API key for the current agent backend (today: [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations); legacy `CURSOR_API_KEY` still works)
- CloudPub CLI (`clo`) if you want a public HTTPS URL for phone access

## Phone access (stable)

For remote use **do not** rely on the test stand — Vite + `tsx watch` restart on file changes and drop WebSocket.

Use production instead:

```bat
start-prod.bat
```

Or manually:

```bash
npm run build
npm start
```

Then tunnel the **same** port:

```bash
clo publish http 8787
```

Open the HTTPS URL CloudPub prints in your phone browser and enter the same `ACCESS_TOKEN`.

### Why this stays up

| Mode | Behavior |
|------|----------|
| `start-stand.bat` / `npm run stand` | Two processes on `:8788`/`:5174`, hot reload — for local UI/feature work |
| `start-prod.bat` | One Node process on `:8787` serves API + built UI — survives agent edits to other repos |

Tips:

- Leave the prod window open; prevent sleep on the PC while you work from the phone.
- Release chats live in `%USERPROFILE%\.webcli\sessions.json` — restarting the server does not wipe history.
- You **can** open workspace `...\cli-web` from the phone and edit this project. Prod will **not** auto-reload; after you change WebCLI itself, rebuild/restart when you want the new UI/server code — or verify first on the stand (`:5174`).
- Prefer working on *other* projects from the phone while WebCLI runs in prod — most stable.

## Setup

```bash
cp .env.example .env
# edit .env — at least AGENT_API_KEY and ACCESS_TOKEN
npm install
npm run stand
```

- Release (prod): `http://127.0.0.1:8787`
- Test stand UI: `http://127.0.0.1:5174` (proxies `/api` and `/ws` to `:8788`)

Open the UI, enter your `ACCESS_TOKEN`, set a workspace path, start a session, chat.

### Production-style local run

```bash
npm run build
npm start
```

Serves the built SPA from Fastify on `PORT` (default `8787`).

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_API_KEY` | yes | Agent backend API key (legacy: `CURSOR_API_KEY`) |
| `ACCESS_TOKEN` | yes | Bearer token for REST/WS. **Quote it** if it contains `#` or spaces: `ACCESS_TOKEN="…"` |
| `CONTEXT7_API_KEY` | no | Context7 docs MCP (`${CONTEXT7_API_KEY}` in `~/.webcli/mcp.json`) |
| `PORT` | no | Default `8787` (stand uses `8788`) |
| `WEBCLI_STAND` | no | Set `1` for test stand (banner + health flag; legacy `CURSOR_CLI_STAND`) |
| `WEBCLI_DATA_DIR` | no | Sessions/push storage (stand defaults to `~/.webcli-stand`; legacy `CURSOR_CLI_DATA_DIR`) |
| `API_PORT` / `VITE_PORT` | no | Vite proxy / UI port (stand: `8788` / `5174`) |
| `DEFAULT_WORKSPACE` | no | Default cwd for new sessions |
| `DEFAULT_MODEL` | no | Default `auto` |
| `WHISPER_ENABLED` | no | Local mic STT via faster-whisper (`1` default; `0` to disable) |
| `WHISPER_MODEL` | no | Default `large-v3` |
| `WHISPER_LANGUAGE` | no | Default `ru`; use `auto` to detect |
| `WHISPER_PYTHON` | no | Python binary (default `python`) |
| `WHISPER_DEVICE` | no | `auto` (CUDA then CPU), `cuda`, or `cpu` |
| `HF_ENDPOINT` | no | Hugging Face hub URL (default `https://hf-mirror.com`) |
| `WHISPER_START_TIMEOUT_MS` | no | Model load/download wait (default `900000` = 15 min) |
| `HTTP_PROXY` / `HTTPS_PROXY` | no | Optional proxy for model download |

Voice input records in the browser and transcribes on this PC with **local Whisper** (no Google Web Speech). Install once:

```bash
pip install -r packages/server/scripts/requirements-whisper.txt
```

Weights are pulled from Hugging Face on first use (`large-v3` is several GB). If `huggingface.co` is blocked, the default mirror is **hf-mirror.com**. Pre-download (recommended behind slow/blocked links):

```bat
download-whisper.bat
```

Or set a proxy in `.env` (`HTTPS_PROXY=…`) / use the official hub (`HF_ENDPOINT=https://huggingface.co`). Needs `ffmpeg` on PATH for webm/m4a from the phone browser.

## MCP (Context7 + board)

On first run / `setup.bat`, WebCLI seeds `~/.webcli/mcp.json` with:

- **context7** — docs MCP; set `CONTEXT7_API_KEY` in `.env` (from https://context7.com)
- **workspace-board** — bundled package `packages/workspace-board-mcp` (kanban tools)

Placeholders like `${CONTEXT7_API_KEY}` are expanded when starting an agent. Edit the file in Settings → MCP, or re-seed:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\write-default-mcp.ps1 -RepoDir "%CD%"
```

## CloudPub (HTTPS tunnel)

Two separate public URLs — one for release, one for the stand:

```bat
rem Terminal A — release (phone “main”)
start-prod.bat
publish-release.bat
rem → clo publish loop (auto-restarts if clo exits after promote)

rem Terminal B — test stand (try features / screenshots from phone)
start-stand-prod.bat
publish-stand.bat
rem → same auto-restart loop for :8788
```

Prefer **`publish-release.bat` (CLI)** over the CloudPub desktop app. The GUI often closes when `:8787` blips during `promote-to-release.bat`; the bat waits for health and reconnects `clo` automatically. Keep that window open.

Or manually:

```bash
clo publish -n webcli http 8787
clo publish -n webcli-stand http 8788
```

Each command prints its own `https://….cloudpub.ru` URL. Use the stand URL only for testing; keep the release URL for day-to-day chat. Same `ACCESS_TOKEN` on both.

Do **not** point CloudPub at Vite `:5174` for phone use — prefer `start-stand-prod.bat` + `:8788`.

## API sketch

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/health` | Public (includes whisper status, `stand` flag) |
| `GET` | `/api/transcribe/status` | Local Whisper worker status |
| `POST` | `/api/transcribe` | `{ audio: base64, mimeType }` → `{ transcription }` |
| `GET` | `/api/sessions` | List in-memory sessions |
| `POST` | `/api/sessions` | `{ workspace, model? }` → create agent |
| `GET` | `/api/sessions/:id` | Session + messages |
| `POST` | `/api/sessions/:id/messages` | `{ text }` → stream over `/ws` |
| `POST` | `/api/sessions/:id/messages/:messageId/rollback` | Restore chat + git workspace to that user turn |
| `POST` | `/api/sessions/:id/resume` | Resume by agent id |
| `DELETE` | `/api/sessions/:id` | Dispose agent |
| `WS` | `/ws?token=…` | Stream events |

Auth: `Authorization: Bearer <ACCESS_TOKEN>` or query `token`.

Sessions are saved in `~/.webcli/sessions.json` (or `WEBCLI_DATA_DIR`) and restored on server start.

### Notifications

Web Push (works on phone even when the tab is closed):

1. Open the **HTTPS** CloudPub URL (required).
2. Tap **Enable** on the notifications banner (user gesture).
3. On **iPhone**: Share → **Add to Home Screen**, open the installed app, then Enable. Safari tabs alone cannot receive push.

VAPID keys are auto-generated in `~/.webcli/vapid.json`. Subscriptions live in `~/.webcli/push-subscriptions.json`.

### Rollback

On each user message the server snapshots the workspace with git (`stash create` + ref). **Restore** on a user bubble truncates later messages, restores the worktree to that snapshot, and starts a **new** agent (SDK has no conversation rewind). Workspace must be a git repo.

## Layout

```
packages/
  server/   Fastify + agent SDK + WebSocket
  web/      React SPA
scripts/
  stand-env.mjs   env wrapper for npm run stand
```
