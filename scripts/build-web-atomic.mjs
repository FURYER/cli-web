/**
 * Build web UI into a staging folder, then atomically swap into web/dist.
 * Avoids a white screen while Vite empties the live release assets mid-build.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "packages", "web");
const dist = join(webRoot, "dist");
const staging = join(webRoot, "dist-next");
const backup = join(webRoot, "dist-prev");

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(staging, { recursive: true, force: true });
rmSync(backup, { recursive: true, force: true });

run("npx", ["tsc", "-b"], webRoot);
run("npx", ["vite", "build", "--outDir", "dist-next", "--emptyOutDir"], webRoot);

if (!existsSync(join(staging, "index.html"))) {
  console.error("[build-web-atomic] staging build missing index.html");
  process.exit(1);
}

mkdirSync(dirname(dist), { recursive: true });

if (existsSync(dist)) {
  renameSync(dist, backup);
}
try {
  renameSync(staging, dist);
} catch (err) {
  // Cross-device / Windows fallback
  console.warn("[build-web-atomic] rename failed, copying:", err);
  mkdirSync(dist, { recursive: true });
  cpSync(staging, dist, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  if (existsSync(backup) && !existsSync(dist)) {
    renameSync(backup, dist);
    throw err;
  }
}

rmSync(backup, { recursive: true, force: true });
console.info("[build-web-atomic] swapped web/dist");
