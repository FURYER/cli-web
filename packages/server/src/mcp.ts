import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@cursor/sdk";
import { dataDir } from "./paths.js";

export type McpServersMap = Record<string, McpServerConfig>;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** cli-web repo root (…/packages/server/src → ../../..). */
export function webcliRoot(): string {
  return resolve(__dirname, "../../..");
}

function mcpFile(): string {
  return join(dataDir(), "mcp.json");
}

function boardMcpEntryPath(): string {
  return join(
    webcliRoot(),
    "packages",
    "workspace-board-mcp",
    "dist",
    "index.js",
  ).replace(/\\/g, "/");
}

/** Persistent Chromium profile for Playwright MCP (cookies / Google login). */
export function playwrightUserDataDir(): string {
  return join(dataDir(), "browser-profiles", "default").replace(/\\/g, "/");
}

/** Stdio bridge: attaches @playwright/mcp to WebCLI's long-lived CDP Chrome. */
export function playwrightCdpBridgePath(): string {
  return join(__dirname, "../mcp/playwright-cdp.mjs").replace(/\\/g, "/");
}

/** Default Playwright args: headed window on the host PC + sticky profile. */
export function defaultPlaywrightArgs(): string[] {
  return [
    "-y",
    "@playwright/mcp@latest",
    `--user-data-dir=${playwrightUserDataDir()}`,
  ];
}

/** Default MCP set for fresh installs (secrets via ${ENV} placeholders). */
export function defaultMcpServers(): McpServersMap {
  return {
    context7: {
      type: "http",
      url: "https://mcp.context7.com/mcp",
      headers: {
        CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}",
      },
    } as McpServerConfig,
    "workspace-board": {
      command: "node",
      args: [boardMcpEntryPath()],
    } as McpServerConfig,
    // Runtime rewrites this to the CDP bridge (see loadMcpServersForAgent).
    playwright: {
      command: "npx",
      args: defaultPlaywrightArgs(),
    } as McpServerConfig,
  };
}

function parseServers(raw: unknown): McpServersMap {
  if (!raw || typeof raw !== "object") return {};
  const root = raw as { mcpServers?: unknown };
  const source =
    root.mcpServers && typeof root.mcpServers === "object"
      ? root.mcpServers
      : raw;
  if (!source || typeof source !== "object") return {};
  return source as McpServersMap;
}

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandString(value: string): string {
  return value.replace(ENV_VAR, (_full, name: string) => {
    if (name === "WEBCLI_ROOT") return webcliRoot().replace(/\\/g, "/");
    if (name === "WORKSPACE_BOARD_MCP") return boardMcpEntryPath();
    return process.env[name] ?? "";
  });
}

function expandValue(value: unknown): unknown {
  if (typeof value === "string") return expandString(value);
  if (Array.isArray(value)) return value.map(expandValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Expand ${ENV} placeholders and drop Context7 when the API key is missing
 * (avoids a broken HTTP MCP with an empty header).
 */
export function resolveMcpServers(servers: McpServersMap): McpServersMap {
  const expanded = expandValue(servers) as McpServersMap;
  const ctx = expanded.context7 as { headers?: Record<string, string> } | undefined;
  const key = ctx?.headers?.CONTEXT7_API_KEY?.trim();
  if (expanded.context7 && !key) {
    const { context7: _drop, ...rest } = expanded;
    return rest;
  }
  return expanded;
}

/** Raw servers from disk / env (placeholders preserved) — for Settings UI. */
export async function readMcpServers(): Promise<McpServersMap> {
  const fromEnv = process.env.MCP_SERVERS_JSON?.trim();
  if (fromEnv) {
    try {
      return parseServers(JSON.parse(fromEnv));
    } catch (err) {
      console.error("Invalid MCP_SERVERS_JSON:", err);
    }
  }

  try {
    const text = await readFile(mcpFile(), "utf8");
    return parseServers(JSON.parse(text));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error("Failed to load mcp.json:", err);
    return {};
  }
}

/** Resolved servers for the agent runtime (no side effects). */
export async function loadMcpServers(): Promise<McpServersMap> {
  return resolveMcpServers(await readMcpServers());
}

/**
 * Like loadMcpServers, but ensures a per-root-agent Chromium is up and points
 * Playwright MCP at it via CDP so stop/end-of-turn does not close the window.
 * Pass the root agent session id (sub-agents share the parent's browser).
 */
export async function loadMcpServersForAgent(
  browserSessionId: string,
): Promise<McpServersMap> {
  const servers = await loadMcpServers();
  return attachPlaywrightCdpBridge(servers, browserSessionId);
}

async function attachPlaywrightCdpBridge(
  servers: McpServersMap,
  browserSessionId: string,
): Promise<McpServersMap> {
  const named = servers.playwright;
  if (!isPlaywrightEntry(named)) return servers;

  const { ensurePlaywrightBrowser, browserProfileKey } = await import(
    "./playwright-browser.js"
  );
  const meta = await ensurePlaywrightBrowser(browserSessionId);
  const bridge = playwrightCdpBridgePath();
  const prevEnv =
    "env" in named && named.env && typeof named.env === "object"
      ? (named.env as Record<string, string>)
      : {};

  return {
    ...servers,
    playwright: {
      command: "node",
      args: [bridge],
      env: {
        ...prevEnv,
        WEBCLI_PW_CDP: meta.cdpHttp,
        WEBCLI_PW_META: join(
          dataDir(),
          "browser-profiles",
          "sessions",
          browserProfileKey(browserSessionId),
          "browser.json",
        ),
      },
    } as McpServerConfig,
  };
}

export async function saveMcpServers(servers: McpServersMap): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(
    mcpFile(),
    JSON.stringify({ mcpServers: servers }, null, 2),
    "utf8",
  );
}

type PlaywrightLike = {
  command?: string;
  args?: string[];
};

function isPlaywrightEntry(cfg: unknown): cfg is PlaywrightLike {
  if (!cfg || typeof cfg !== "object") return false;
  const c = cfg as PlaywrightLike;
  if (!Array.isArray(c.args)) return false;
  return c.args.some(
    (a) => typeof a === "string" && a.includes("@playwright/mcp"),
  );
}

/**
 * Drop --headless and ensure --user-data-dir for an existing playwright MCP entry.
 * Returns true when args were changed.
 */
export function migratePlaywrightArgs(args: string[]): {
  args: string[];
  changed: boolean;
} {
  const profileFlag = `--user-data-dir=${playwrightUserDataDir()}`;
  let next = args.filter((a) => a !== "--headless" && a !== "--headed");
  const hasProfile = next.some(
    (a) => typeof a === "string" && a.startsWith("--user-data-dir="),
  );
  if (!hasProfile) {
    next = [...next, profileFlag];
  } else {
    next = next.map((a) =>
      typeof a === "string" && a.startsWith("--user-data-dir=")
        ? profileFlag
        : a,
    );
  }
  return { args: next, changed: next.join("\0") !== args.join("\0") };
}

/**
 * Create or update ~/.webcli/mcp.json with default servers.
 * Existing entries are kept; missing built-ins (e.g. playwright) are merged in.
 * Also migrates playwright off --headless onto a sticky user-data-dir.
 * Returns true if the file was written/updated.
 */
export async function ensureDefaultMcpServers(): Promise<boolean> {
  if (process.env.MCP_SERVERS_JSON?.trim()) return false;

  const defaults = defaultMcpServers();
  let wrote = false;

  if (!existsSync(mcpFile())) {
    await saveMcpServers(defaults);
    console.info(`seeded default MCP config at ${mcpFile()}`);
    return true;
  }

  const existing = await readMcpServers();
  if (Object.keys(existing).length === 0) {
    await saveMcpServers(defaults);
    console.info(`seeded default MCP config at ${mcpFile()}`);
    return true;
  }

  const merged: McpServersMap = { ...existing };
  const added: string[] = [];
  for (const [name, cfg] of Object.entries(defaults)) {
    if (!(name in merged)) {
      merged[name] = cfg;
      added.push(name);
    }
  }
  if (added.length > 0) {
    wrote = true;
    console.info(
      `merged default MCP servers (${added.join(", ")}) into ${mcpFile()}`,
    );
  }

  const pw = merged.playwright;
  if (isPlaywrightEntry(pw) && Array.isArray(pw.args)) {
    const { args, changed } = migratePlaywrightArgs(pw.args);
    if (changed) {
      merged.playwright = { ...pw, args } as McpServerConfig;
      wrote = true;
      console.info(
        `migrated playwright MCP to headed + user-data-dir (${mcpFile()})`,
      );
    }
  }

  if (!wrote) return false;
  await saveMcpServers(merged);
  return true;
}
