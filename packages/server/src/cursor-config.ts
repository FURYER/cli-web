import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ConfigDocKind = "rule" | "skill";
export type ConfigDocSource = "user" | "project" | "builtin";

export type ConfigDocSummary = {
  id: string;
  name: string;
  source: ConfigDocSource;
  kind: ConfigDocKind;
  path: string;
  description?: string;
};

export type ConfigDocDetail = ConfigDocSummary & {
  content: string;
};

function builtinRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "builtin");
}

function userCursorDir(): string {
  return join(homedir(), ".cursor");
}

function parseFrontmatter(raw: string): { description?: string; name?: string } {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const fm = raw.slice(3, end).trim();
  let description: string | undefined;
  let name: string | undefined;

  const nameLine = fm.match(/^name:\s*(.+)$/m);
  if (nameLine?.[1]) {
    name = nameLine[1].trim().replace(/^["']|["']$/g, "");
  }

  const descBlock = fm.match(/description:\s*[>|]-?\s*\n((?:[ \t]+.+\n?)*)/);
  if (descBlock?.[1]) {
    description = descBlock[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]+/, "").trim())
      .filter(Boolean)
      .join(" ");
  } else {
    const descLine = fm.match(/^description:\s*(.+)$/m);
    if (descLine?.[1]) {
      description = descLine[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return { description, name };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isUnder(root: string, file: string): boolean {
  const rootAbs = resolve(root);
  const fileAbs = resolve(file);
  if (process.platform === "win32") {
    const r = rootAbs.toLowerCase();
    const f = fileAbs.toLowerCase();
    return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
  }
  return fileAbs === rootAbs || fileAbs.startsWith(rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep);
}

async function listFilesRecursive(dir: string, exts: Set<string>): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, exts)));
    } else if (exts.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

async function collectRules(source: ConfigDocSource, root: string): Promise<ConfigDocSummary[]> {
  const files = await listFilesRecursive(join(root, "rules"), new Set([".md", ".mdc"]));
  const items: ConfigDocSummary[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const meta = parseFrontmatter(raw);
    items.push({
      id: `${source}:rule:${file}`,
      name: meta.name || basename(file).replace(/\.(md|mdc)$/i, ""),
      source,
      kind: "rule",
      path: file,
      description: meta.description,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectSkills(source: ConfigDocSource, root: string): Promise<ConfigDocSummary[]> {
  const dir = join(root, "skills");
  if (!(await pathExists(dir))) return [];
  const items: ConfigDocSummary[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!(await pathExists(skillFile))) continue;
    const raw = await readFile(skillFile, "utf8");
    const meta = parseFrontmatter(raw);
    items.push({
      id: `${source}:skill:${skillFile}`,
      name: meta.name || entry.name,
      source,
      kind: "skill",
      path: skillFile,
      description: meta.description,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listRules(workspace?: string): Promise<ConfigDocSummary[]> {
  const builtin = await collectRules("builtin", builtinRoot());
  const builtinKeys = new Set(
    builtin.map((item) => basename(item.path).toLowerCase()),
  );
  const user = (await collectRules("user", userCursorDir())).filter(
    (item) => !builtinKeys.has(basename(item.path).toLowerCase()),
  );
  const items: ConfigDocSummary[] = [...builtin, ...user];
  if (workspace?.trim()) {
    items.push(...(await collectRules("project", join(workspace.trim(), ".cursor"))));
  }
  return items;
}

export async function listSkills(workspace?: string): Promise<ConfigDocSummary[]> {
  const builtin = await collectSkills("builtin", builtinRoot());
  const builtinKeys = new Set(builtin.map((item) => item.name.toLowerCase()));
  const user = (await collectSkills("user", userCursorDir())).filter(
    (item) => !builtinKeys.has(item.name.toLowerCase()),
  );
  const items: ConfigDocSummary[] = [...builtin, ...user];
  if (workspace?.trim()) {
    items.push(...(await collectSkills("project", join(workspace.trim(), ".cursor"))));
  }
  return items;
}

export async function readConfigDoc(
  filePath: string,
  workspace?: string,
): Promise<ConfigDocDetail> {
  const allowedRoots = [
    builtinRoot(),
    userCursorDir(),
    workspace?.trim() ? join(workspace.trim(), ".cursor") : null,
  ].filter(Boolean) as string[];

  const resolved = resolve(filePath);
  if (!allowedRoots.some((root) => isUnder(root, resolved))) {
    throw new Error("Path not allowed");
  }

  const raw = await readFile(resolved, "utf8");
  const meta = parseFrontmatter(raw);
  const kind: ConfigDocKind = /[/\\]skills[/\\]/i.test(resolved) ? "skill" : "rule";

  let source: ConfigDocSource = "user";
  if (isUnder(builtinRoot(), resolved)) source = "builtin";
  else if (workspace?.trim() && isUnder(join(workspace.trim(), ".cursor"), resolved)) {
    source = "project";
  }

  const name =
    meta.name ||
    (kind === "skill" ? basename(dirname(resolved)) : basename(resolved).replace(/\.(md|mdc)$/i, ""));

  return {
    id: `${source}:${kind}:${resolved}`,
    name,
    source,
    kind,
    path: resolved,
    description: meta.description,
    content: raw,
  };
}

/** Install built-in skills into ~/.cursor/skills for agents with settingSources: user. */
export async function syncBuiltinSkillsToUser(): Promise<void> {
  const srcSkills = join(builtinRoot(), "skills");
  if (!(await pathExists(srcSkills))) return;
  const destRoot = join(userCursorDir(), "skills");
  await mkdir(destRoot, { recursive: true });
  const entries = await readdir(srcSkills, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const from = join(srcSkills, entry.name, "SKILL.md");
    if (!(await pathExists(from))) continue;
    const toDir = join(destRoot, entry.name);
    await mkdir(toDir, { recursive: true });
    await copyFile(from, join(toDir, "SKILL.md"));
  }
}

/** Install built-in rules into ~/.cursor/rules. */
export async function syncBuiltinRulesToUser(): Promise<void> {
  const srcRules = join(builtinRoot(), "rules");
  if (!(await pathExists(srcRules))) return;
  const destRoot = join(userCursorDir(), "rules");
  await mkdir(destRoot, { recursive: true });
  const files = await listFilesRecursive(srcRules, new Set([".md", ".mdc"]));
  for (const from of files) {
    const name = basename(from);
    await copyFile(from, join(destRoot, name));
  }
}

export async function syncBuiltinConfigToUser(): Promise<void> {
  await syncBuiltinSkillsToUser();
  await syncBuiltinRulesToUser();
}
