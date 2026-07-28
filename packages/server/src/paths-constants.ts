/** Shared path constants (no side effects — safe for agent-home bootstrap). */

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
