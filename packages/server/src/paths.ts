import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Product display name (UI, logs, PWA). */
export const APP_NAME = "WebCLI";

/** Default session/push data folder under the user home. */
export const DATA_DIR_NAME = ".webcli";
export const DATA_DIR_NAME_STAND = ".webcli-stand";

/** Pre-rebrand folders — migrated once on startup. */
export const LEGACY_DATA_DIR_NAME = ".cursor-cli";
export const LEGACY_DATA_DIR_NAME_STAND = ".cursor-cli-stand";

/** Workspace board folder (inside each project). */
export const WORKSPACE_META_DIR = ".webcli";
export const LEGACY_WORKSPACE_META_DIR = ".cursor-cli";

export function isStandMode(): boolean {
  const v =
    process.env.WEBCLI_STAND?.trim() || process.env.CURSOR_CLI_STAND?.trim();
  return v === "1";
}

/**
 * Resolve the host data directory (sessions, push, mcp.json, …).
 * Prefer WEBCLI_*; fall back to legacy CURSOR_CLI_* for one release cycle.
 */
export function dataDir(): string {
  const explicit =
    process.env.WEBCLI_DATA_DIR?.trim() ||
    process.env.CURSOR_CLI_DATA_DIR?.trim();
  if (explicit) return explicit;
  return join(
    homedir(),
    isStandMode() ? DATA_DIR_NAME_STAND : DATA_DIR_NAME,
  );
}

/**
 * If the resolved data dir is missing and the matching legacy folder exists,
 * rename it (works even when WEBCLI_DATA_DIR is set to the default path).
 */
export async function migrateDataDirIfNeeded(): Promise<string | null> {
  const next = dataDir();
  if (existsSync(next)) return null;

  const legacy = isStandMode()
    ? join(homedir(), LEGACY_DATA_DIR_NAME_STAND)
    : join(homedir(), LEGACY_DATA_DIR_NAME);

  if (!existsSync(legacy) || legacy === next) return null;

  await rename(legacy, next);
  return `migrated data dir ${legacy} → ${next}`;
}

/** Agent backend API key (currently Cursor). Accepts legacy CURSOR_API_KEY. */
export function requireAgentApiKey(): string {
  const key =
    process.env.AGENT_API_KEY?.trim() || process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    throw new Error("AGENT_API_KEY is not set (legacy CURSOR_API_KEY also accepted)");
  }
  return key;
}

export function hasAgentApiKey(): boolean {
  return Boolean(
    process.env.AGENT_API_KEY?.trim() || process.env.CURSOR_API_KEY?.trim(),
  );
}

export function boardFilePath(workspace: string): string {
  return join(workspace, WORKSPACE_META_DIR, "board.json");
}

export function legacyBoardFilePath(workspace: string): string {
  return join(workspace, LEGACY_WORKSPACE_META_DIR, "board.json");
}
