---
name: share-workspace-media
description: >-
  Share screenshots, images, short videos, and downloadable files in Web CLI
  chat. Use when the user asks to show a screenshot, UI, game frame, generated
  image, video clip, or to "скинуть" media/files in chat.
---

# Share media and files in Web CLI chat

Chat previews/downloads are **not** project files by default. Web CLI stores
generated/preview media in the session data directory and shows it
automatically — do **not** copy images into the project workspace just so the
user can look at them.

## When this applies

User asks to see a screenshot, preview, generated image, game frame, short
recording, **or to download any file from the PC** (any path on disk).

## Images and videos

1. Prefer `generateImage` / screen capture tools. Web CLI auto-ingests the
   result into chat media and displays it.
2. If you must mention a path in text, a `chat-media/...` link is fine after
   ingest; do not invent `captures/` paths in the repo.
3. Only write into the **workspace** when the file is a real project asset
   (e.g. `assets/logo.png` the app will ship). Then link that workspace path.
4. Supported inline: png, jpeg, webp, gif, mp4, webm, mov.

## Arbitrary file download (any path on the computer)

The media API can serve **any readable file on the host** (max ~100 MB), not
only workspace files. Auth is required (same as the rest of Web CLI).

1. Find the file (absolute path is fine: Desktop, Downloads, other drives, …).
2. Reply with a markdown link using that path — **do not copy into the project**
   just for sharing:
   - Windows: `[report.pdf](C:/Users/me/Desktop/report.pdf)`
   - Or workspace-relative: `[report.pdf](docs/report.pdf)`
3. Prefer forward slashes in the link. Use the real filename as the label.
4. Non-media must use `[label](path)` (Download chip). Images/videos still use
   `![…](…)` / auto-ingest.
5. Do **not** paste base64.

## Do not

- Create `captures/` (or similar) in the project only for chat previews.
- Copy files into the git workspace solely so the user can download them —
  link the absolute path instead.
- Paste huge base64 into the chat text.
- Claim a file is a project asset unless it truly belongs in the repo.
