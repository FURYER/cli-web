import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "./paths.js";

/** Base CDP port; each root agent gets a stable offset in [BASE, BASE+199]. */
export const PLAYWRIGHT_CDP_PORT_BASE = 9333;
const PORT_SPAN = 200;

type BrowserMeta = {
  sessionId: string;
  pid: number;
  port: number;
  cdpHttp: string;
  userDataDir: string;
  startedAt: number;
};

type Slot = {
  child: ChildProcess | null;
  starting: Promise<BrowserMeta> | null;
  meta: BrowserMeta | null;
};

const slots = new Map<string, Slot>();

function profilesRoot(): string {
  return join(dataDir(), "browser-profiles");
}

/** Safe directory name for a session id. */
export function browserProfileKey(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return cleaned || "unknown";
}

function userDataDirFor(sessionId: string): string {
  return join(profilesRoot(), "sessions", browserProfileKey(sessionId)).replace(
    /\\/g,
    "/",
  );
}

function metaPathFor(sessionId: string): string {
  return join(profilesRoot(), "sessions", browserProfileKey(sessionId), "browser.json");
}

function getSlot(sessionId: string): Slot {
  let slot = slots.get(sessionId);
  if (!slot) {
    slot = { child: null, starting: null, meta: null };
    slots.set(sessionId, slot);
  }
  return slot;
}

function preferredPort(sessionId: string): number {
  const hash = createHash("sha256").update(sessionId).digest();
  const n = hash.readUInt16BE(0) % PORT_SPAN;
  return PLAYWRIGHT_CDP_PORT_BASE + n;
}

export function playwrightCdpHttp(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function findChromeExecutable(): string | null {
  const candidates = [
    process.env.WEBCLI_CHROME_PATH?.trim(),
    process.env.CHROME_PATH?.trim(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(
      process.env.LOCALAPPDATA || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((p): p is string => Boolean(p && p.length > 0));

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function readMeta(sessionId: string): Promise<BrowserMeta | null> {
  try {
    const raw = await readFile(metaPathFor(sessionId), "utf8");
    const parsed = JSON.parse(raw) as BrowserMeta;
    if (!parsed?.pid || !parsed?.port || !parsed?.cdpHttp) return null;
    return { ...parsed, sessionId };
  } catch {
    return null;
  }
}

async function writeMeta(meta: BrowserMeta): Promise<void> {
  await mkdir(dirname(metaPathFor(meta.sessionId)), { recursive: true });
  await writeFile(metaPathFor(meta.sessionId), JSON.stringify(meta, null, 2), "utf8");
}

async function clearMeta(sessionId: string): Promise<void> {
  try {
    await unlink(metaPathFor(sessionId));
  } catch {
    /* ignore */
  }
}

export async function isPlaywrightCdpAlive(cdpHttp: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpHttp.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPid(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/F", "/PID", String(pid), "/T"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

async function killChromeUsingProfile(profile: string): Promise<void> {
  const needles = [
    profile.replace(/\//g, "\\").toLowerCase(),
    profile.replace(/\\/g, "/").toLowerCase(),
  ];

  if (process.platform === "win32") {
    const ps = [
      `$needles = @(${needles.map((n) => JSON.stringify(n)).join(", ")})`,
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {`,
      `  $c = $_.CommandLine; if (-not $c) { return }`,
      `  $cl = $c.ToLower()`,
      `  foreach ($n in $needles) {`,
      `    if ($cl.Contains($n)) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; break }`,
      `  }`,
      `}`,
    ].join("; ");
    await new Promise<void>((resolve) => {
      const listing = spawn("powershell.exe", ["-NoProfile", "-Command", ps], {
        stdio: "ignore",
        windowsHide: true,
      });
      listing.on("exit", () => resolve());
      listing.on("error", () => resolve());
    });
  } else {
    await new Promise<void>((resolve) => {
      const listing = spawn(
        "bash",
        ["-lc", `pkill -f ${JSON.stringify(needles[1])} 2>/dev/null || true`],
        { stdio: "ignore" },
      );
      listing.on("exit", () => resolve());
      listing.on("error", () => resolve());
    });
  }
  await new Promise((r) => setTimeout(r, 400));
}

async function waitForCdp(cdpHttp: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPlaywrightCdpAlive(cdpHttp)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chromium CDP did not become ready at ${cdpHttp}`);
}

async function pickFreePort(sessionId: string): Promise<number> {
  const start = preferredPort(sessionId);
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = PLAYWRIGHT_CDP_PORT_BASE + ((start - PLAYWRIGHT_CDP_PORT_BASE + i) % PORT_SPAN);
    const cdpHttp = playwrightCdpHttp(port);
    if (await isPlaywrightCdpAlive(cdpHttp)) {
      // In use by someone — skip unless it's our own meta for this session.
      const meta = await readMeta(sessionId);
      if (meta?.port === port) return port;
      continue;
    }
    return port;
  }
  throw new Error("No free CDP port for Playwright browser");
}

/**
 * Stop Chromium for one root agent session (chat close / browser_close).
 * Safe if nothing is running.
 */
export async function stopPlaywrightBrowser(sessionId: string): Promise<void> {
  const slot = getSlot(sessionId);
  const meta = slot.meta ?? (await readMeta(sessionId));
  if (slot.child) {
    const proc = slot.child;
    slot.child = null;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
  if (meta?.pid) await killPid(meta.pid);
  if (meta?.userDataDir) await killChromeUsingProfile(meta.userDataDir);
  else await killChromeUsingProfile(userDataDirFor(sessionId));
  await clearMeta(sessionId);
  slot.meta = null;
  slot.starting = null;
  slots.delete(sessionId);
}

/** Stop every managed Playwright Chromium (server shutdown). */
export async function stopAllPlaywrightBrowsers(): Promise<void> {
  const ids = new Set<string>([...slots.keys()]);
  try {
    const sessionsDir = join(profilesRoot(), "sessions");
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const metaFile = join(sessionsDir, ent.name, "browser.json");
      try {
        const raw = await readFile(metaFile, "utf8");
        const parsed = JSON.parse(raw) as BrowserMeta;
        if (parsed?.sessionId) ids.add(parsed.sessionId);
        else ids.add(ent.name);
      } catch {
        ids.add(ent.name);
      }
    }
  } catch {
    /* no sessions dir yet */
  }

  // Also clear legacy shared default browser from the first iteration.
  const legacyMeta = join(profilesRoot(), "default", "browser.json");
  try {
    const raw = await readFile(legacyMeta, "utf8");
    const parsed = JSON.parse(raw) as BrowserMeta;
    if (parsed?.pid) await killPid(parsed.pid);
    await killChromeUsingProfile(join(profilesRoot(), "default").replace(/\\/g, "/"));
    await unlink(legacyMeta).catch(() => undefined);
  } catch {
    /* ignore */
  }

  await Promise.all([...ids].map((id) => stopPlaywrightBrowser(id)));
}

async function launchChrome(sessionId: string): Promise<BrowserMeta> {
  const exe = findChromeExecutable();
  if (!exe) {
    throw new Error(
      "No Chrome/Edge found for Playwright MCP. Set WEBCLI_CHROME_PATH.",
    );
  }

  const profile = userDataDirFor(sessionId);
  await mkdir(profile, { recursive: true });
  const port = await pickFreePort(sessionId);
  const cdpHttp = playwrightCdpHttp(port);
  const slot = getSlot(sessionId);

  const prev = await readMeta(sessionId);
  if (prev?.pid) await killPid(prev.pid);
  await killChromeUsingProfile(profile);

  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ];

  const proc = spawn(exe, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false,
    detached: false,
  });
  slot.child = proc;

  proc.stderr?.on("data", (buf: Buffer) => {
    const line = buf.toString("utf8").trim();
    if (line) console.error(`[playwright-browser:${browserProfileKey(sessionId)}] ${line}`);
  });
  proc.on("exit", () => {
    if (slot.child === proc) slot.child = null;
    slot.meta = null;
    void clearMeta(sessionId);
  });

  if (proc.pid == null) {
    throw new Error("Failed to start Chromium (no pid)");
  }

  try {
    await waitForCdp(cdpHttp);
  } catch (err) {
    await killPid(proc.pid);
    slot.child = null;
    throw err;
  }

  const meta: BrowserMeta = {
    sessionId,
    pid: proc.pid,
    port,
    cdpHttp,
    userDataDir: profile,
    startedAt: Date.now(),
  };
  await writeMeta(meta);
  slot.meta = meta;
  console.info(
    `[playwright-browser] session=${browserProfileKey(sessionId)} CDP ${cdpHttp} (pid ${proc.pid})`,
  );
  return meta;
}

/**
 * Ensure a headed Chromium for this root agent session.
 * Sub-agents must pass the parent's (root) session id so they share one window.
 */
export async function ensurePlaywrightBrowser(
  sessionId: string,
): Promise<BrowserMeta> {
  const slot = getSlot(sessionId);
  if (slot.starting) return slot.starting;

  slot.starting = (async () => {
    const existing = slot.meta ?? (await readMeta(sessionId));
    if (existing?.cdpHttp && (await isPlaywrightCdpAlive(existing.cdpHttp))) {
      slot.meta = existing;
      return existing;
    }
    if (existing?.pid) await killPid(existing.pid);
    await clearMeta(sessionId);
    return launchChrome(sessionId);
  })();

  try {
    return await slot.starting;
  } finally {
    slot.starting = null;
  }
}
