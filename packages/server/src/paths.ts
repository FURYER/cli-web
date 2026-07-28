import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR_NAME,
  DATA_DIR_NAME_STAND,
  isStandMode,
  LEGACY_DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME_STAND,
  LEGACY_WORKSPACE_META_DIR,
  WORKSPACE_META_DIR,
} from "./paths-constants.js";

export {
  DATA_DIR_NAME,
  DATA_DIR_NAME_STAND,
  isStandMode,
  LEGACY_DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME_STAND,
  LEGACY_WORKSPACE_META_DIR,
  WORKSPACE_META_DIR,
} from "./paths-constants.js";

/** Product display name (UI, logs, PWA). */
export const APP_NAME = "WebCLI";

/**
 * Real OS user home (Cursor IDE, Documents, …).
 * Prefer WEBCLI_REAL_HOME set by agent-home-setup before USERPROFILE is redirected.
 */
export function realHomedir(): string {
  return (
    process.env.WEBCLI_REAL_HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    process.env.HOME?.trim() ||
    homedir()
  );
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
    realHomedir(),
    isStandMode() ? DATA_DIR_NAME_STAND : DATA_DIR_NAME,
  );
}

/** Canonical WebCLI agent rules/skills root (`~/.webcli/agent`). */
export function agentConfigDir(): string {
  return join(dataDir(), "agent");
}

/**
 * If the resolved data dir is missing and the matching legacy folder exists,
 * rename it (works even when WEBCLI_DATA_DIR is set to the default path).
 */
export async function migrateDataDirIfNeeded(): Promise<string | null> {
  const next = dataDir();
  if (existsSync(next)) return null;

  const legacy = isStandMode()
    ? join(realHomedir(), LEGACY_DATA_DIR_NAME_STAND)
    : join(realHomedir(), LEGACY_DATA_DIR_NAME);

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

export function boardFilesDir(workspace: string, cardId?: string): string {
  const root = join(workspace, WORKSPACE_META_DIR, "board-files");
  return cardId ? join(root, cardId) : root;
}

export function legacyBoardFilePath(workspace: string): string {
  return join(workspace, LEGACY_WORKSPACE_META_DIR, "board.json");
}
