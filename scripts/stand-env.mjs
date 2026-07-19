/**
 * Test stand env: does not touch the release process on :8787.
 * Release stays on :8787 / ~/.webcli — this uses :8788 / :5174 / ~/.webcli-stand.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.argv[2]; // "server" | "web"
if (target !== "server" && target !== "web") {
  console.error("Usage: node scripts/stand-env.mjs <server|web>");
  process.exit(1);
}

const env = {
  ...process.env,
  WEBCLI_STAND: "1",
  WEBCLI_DATA_DIR: join(homedir(), ".webcli-stand"),
  PORT: process.env.PORT || "8788",
  API_PORT: process.env.API_PORT || "8788",
  VITE_PORT: process.env.VITE_PORT || "5174",
};

const args =
  target === "server"
    ? ["run", "dev", "-w", "@webcli/server"]
    : ["run", "dev", "-w", "@webcli/web"];

const child = spawn("npm", args, {
  env,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
