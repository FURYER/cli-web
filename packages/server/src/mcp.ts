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

/** Resolved servers for the agent runtime. */
export async function loadMcpServers(): Promise<McpServersMap> {
  return resolveMcpServers(await readMcpServers());
}

export async function saveMcpServers(servers: McpServersMap): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(
    mcpFile(),
    JSON.stringify({ mcpServers: servers }, null, 2),
    "utf8",
  );
}

/**
 * Create ~/.webcli/mcp.json with Context7 + workspace-board when missing/empty.
 * Returns true if a new file was written.
 */
export async function ensureDefaultMcpServers(): Promise<boolean> {
  if (process.env.MCP_SERVERS_JSON?.trim()) return false;
  if (existsSync(mcpFile())) {
    const existing = await readMcpServers();
    if (Object.keys(existing).length > 0) return false;
  }
  await saveMcpServers(defaultMcpServers());
  console.info(`seeded default MCP config at ${mcpFile()}`);
  return true;
}
