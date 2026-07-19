import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "@cursor/sdk";
import { dataDir } from "./paths.js";

export type McpServersMap = Record<string, McpServerConfig>;

function mcpFile(): string {
  return join(dataDir(), "mcp.json");
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

export async function loadMcpServers(): Promise<McpServersMap> {
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

export async function saveMcpServers(servers: McpServersMap): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(
    mcpFile(),
    JSON.stringify({ mcpServers: servers }, null, 2),
    "utf8",
  );
}
