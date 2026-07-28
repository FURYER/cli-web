/**
 * Isolate WebCLI agent rules/skills from the real Cursor IDE home.
 *
 * Cursor SDK loads user settings from `os.homedir()/.cursor/{rules,skills}`.
 * We keep the canonical WebCLI copies under `~/.webcli/agent/` and point this
 * Node process's USERPROFILE/HOME at a tiny fake home whose `.cursor` junctions
 * there — so Cursor Settings (~/.cursor) stays free of WebCLI builtins.
 *
 * Must be imported before `@cursor/sdk` / agent code touches `os.homedir()`.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRootEnv } from "./env.js";
import {
  DATA_DIR_NAME,
  DATA_DIR_NAME_STAND,
  isStandMode,
} from "./paths-constants.js";

// .env may set WEBCLI_DATA_DIR / WEBCLI_STAND before we pick paths.
loadRootEnv();

function captureRealHome(): string {
  const existing = process.env.WEBCLI_REAL_HOME?.trim();
  if (existing) return existing;
  const fromEnv =
    process.env.USERPROFILE?.trim() ||
    process.env.HOME?.trim() ||
    homedir();
  process.env.WEBCLI_REAL_HOME = fromEnv;
  return fromEnv;
}

function resolveDataDir(realHome: string): string {
  const explicit =
    process.env.WEBCLI_DATA_DIR?.trim() ||
    process.env.CURSOR_CLI_DATA_DIR?.trim();
  if (explicit) return explicit;
  return join(
    realHome,
    isStandMode() ? DATA_DIR_NAME_STAND : DATA_DIR_NAME,
  );
}

function ensureJunction(target: string, linkPath: string): void {
  mkdirSync(join(linkPath, ".."), { recursive: true });
  if (existsSync(linkPath)) {
    try {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        rmSync(linkPath);
      } else {
        // Real dir left from an older layout — replace with junction.
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      rmSync(linkPath, { recursive: true, force: true });
    }
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(target, linkPath, type);
}

const realHome = captureRealHome();
const data = resolveDataDir(realHome);
const agentConfigDir = join(data, "agent");
const agentHomeDir = join(data, "agent-home");

mkdirSync(join(agentConfigDir, "rules"), { recursive: true });
mkdirSync(join(agentConfigDir, "skills"), { recursive: true });
mkdirSync(agentHomeDir, { recursive: true });
ensureJunction(agentConfigDir, join(agentHomeDir, ".cursor"));

// Point this process at the fake home so SDK user settingSources resolve here.
process.env.USERPROFILE = agentHomeDir;
process.env.HOME = agentHomeDir;

export const AGENT_CONFIG_DIR = agentConfigDir;
export const AGENT_HOME_DIR = agentHomeDir;
export const REAL_HOME_DIR = realHome;
