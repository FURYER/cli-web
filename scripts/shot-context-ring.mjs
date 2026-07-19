import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../tmp/context-ring-shots");
await mkdir(outDir, { recursive: true });

function ensurePlaywright() {
  try {
    createRequire(import.meta.url)("playwright");
    return;
  } catch {
    console.log("Installing playwright (temporary, for screenshots)…");
    const r = spawnSync("npm", ["install", "--no-save", "playwright@1.54.2"], {
      cwd: join(here, ".."),
      stdio: "inherit",
      shell: true,
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
    const br = spawnSync("npx", ["playwright", "install", "chromium"], {
      cwd: join(here, ".."),
      stdio: "inherit",
      shell: true,
    });
    if (br.status !== 0) process.exit(br.status ?? 1);
  }
}

ensurePlaywright();
const { chromium } = createRequire(import.meta.url)("playwright");

const htmlPath = join(here, "context-ring-preview.html");
const base = pathToFileURL(htmlPath).href;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 720, height: 640 },
  deviceScaleFactor: 2,
});

const shots = [
  { mode: "collapsed", file: "context-ring-collapsed.png" },
  { mode: "hover", file: "context-ring-hover.png" },
  { mode: "expanded", file: "context-ring-expanded.png" },
];

for (const shot of shots) {
  await page.goto(`${base}?mode=${shot.mode}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const path = join(outDir, shot.file);
  await page.screenshot({ path, type: "png" });
  console.log("wrote", path);
}

await browser.close();

const manifest = shots.map((s) => join(outDir, s.file));
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("done");
