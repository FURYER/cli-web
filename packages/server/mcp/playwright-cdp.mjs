#!/usr/bin/env node
/**
 * Stdio bridge for Playwright MCP over a long-lived Chromium (CDP).
 *
 * WebCLI starts Chrome with --remote-debugging-port; this process only runs
 * @playwright/mcp attached to that CDP endpoint. When the agent run ends and
 * this stdio process is killed, Chrome stays up (tabs/cookies survive).
 *
 * On tools/call browser_close, kill the managed Chrome so the window goes away.
 *
 * Env:
 *   WEBCLI_PW_CDP   http://127.0.0.1:9333
 *   WEBCLI_PW_META  path to browser.json (pid)
 */
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";

const CDP = (process.env.WEBCLI_PW_CDP || "http://127.0.0.1:9333").replace(
  /\/$/,
  "",
);
const META = process.env.WEBCLI_PW_META || "";

function log(...args) {
  console.error("[playwright-cdp]", ...args);
}

function killManagedChrome() {
  if (!META) return;
  try {
    const meta = JSON.parse(readFileSync(META, "utf8"));
    const pid = Number(meta?.pid);
    if (Number.isFinite(pid) && pid > 0) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/PID", String(pid), "/T"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* ignore */
        }
      }
      log(`stopped chrome pid ${pid} after browser_close`);
    }
  } catch (err) {
    log("failed to stop chrome:", err instanceof Error ? err.message : err);
  }
  try {
    unlinkSync(META);
  } catch {
    /* ignore */
  }
}

const child = spawn(
  "npx",
  ["-y", "@playwright/mcp@latest", `--cdp-endpoint=${CDP}`],
  {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: process.env,
  },
);

const pendingCloseIds = new Set();

const clientIn = createInterface({ input: process.stdin });
clientIn.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (
      msg?.method === "tools/call" &&
      msg?.params?.name === "browser_close" &&
      msg.id != null
    ) {
      pendingCloseIds.add(msg.id);
    }
  } catch {
    /* ignore non-json */
  }
  child.stdin.write(line + "\n");
});

const childOut = createInterface({ input: child.stdout });
childOut.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg?.id != null && pendingCloseIds.has(msg.id)) {
      pendingCloseIds.delete(msg.id);
      // Let the tool result reach the agent first, then tear down Chrome.
      setTimeout(() => killManagedChrome(), 50);
    }
  } catch {
    /* ignore */
  }
  process.stdout.write(line + "\n");
});

child.stderr.on("data", (buf) => {
  process.stderr.write(buf);
});

child.on("exit", (code, signal) => {
  // Do NOT kill Chrome here — agent stop/dispose should leave the window open.
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
