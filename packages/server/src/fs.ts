import { constants } from "node:fs";
import { access, opendir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";

export type FsEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
};

export type FsShortcut = {
  label: string;
  path: string;
};

export type FsListing = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  roots: string[];
  shortcuts: FsShortcut[];
  warning?: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** True if we can open the directory (filters Windows junction/EPERM shells). */
async function canListDirectory(path: string): Promise<boolean> {
  try {
    const dir = await opendir(path);
    await dir.close();
    return true;
  } catch {
    return false;
  }
}

export async function listDriveRoots(): Promise<string[]> {
  if (process.platform === "win32") {
    const roots: string[] = [];
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      if (await pathExists(root)) roots.push(root);
    }
    return roots;
  }
  return ["/"];
}

export async function listShortcuts(): Promise<FsShortcut[]> {
  const home = homedir();
  const candidates: FsShortcut[] = [
    { label: "Home", path: home },
    { label: "Documents", path: join(home, "Documents") },
    { label: "Desktop", path: join(home, "Desktop") },
    { label: "Downloads", path: join(home, "Downloads") },
  ];
  if (process.env.DEFAULT_WORKSPACE?.trim()) {
    candidates.unshift({
      label: "Default",
      path: process.env.DEFAULT_WORKSPACE.trim(),
    });
  }

  const out: FsShortcut[] = [];
  for (const item of candidates) {
    if ((await pathExists(item.path)) && (await canListDirectory(item.path))) {
      out.push(item);
    }
  }
  return out;
}

function parentPath(path: string): string | null {
  const normalized = resolve(path);
  const parent = dirname(normalized);
  if (parent === normalized) return null;
  if (process.platform === "win32") {
    const { root } = parse(normalized);
    if (normalized === root || normalized + sep === root) return null;
  }
  return parent;
}

function normalizeTarget(rawPath: string): string {
  let target = rawPath.replace(/\//g, sep);
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(target)) {
    target = `${target}\\`;
  }
  return resolve(target);
}

export async function listDirectory(
  rawPath?: string,
  options?: { includeFiles?: boolean },
): Promise<FsListing> {
  const includeFiles = Boolean(options?.includeFiles);
  const roots = await listDriveRoots();
  const shortcuts = await listShortcuts();
  const home = homedir();
  const fallback =
    process.env.DEFAULT_WORKSPACE?.trim() ||
    shortcuts.find((s) => s.label === "Documents")?.path ||
    home ||
    roots[0] ||
    process.cwd();

  let target = normalizeTarget(rawPath?.trim() || fallback);
  let warning: string | undefined;

  if (!(await pathExists(target))) {
    warning = `Path not found: ${target}`;
    target = normalizeTarget(fallback);
  } else if (!(await canListDirectory(target))) {
    warning = `Cannot open "${target}" (permission / special Windows folder). Showing a safe folder instead.`;
    const safe =
      shortcuts.find((s) => s.label === "Documents")?.path ||
      shortcuts.find((s) => s.label === "Home")?.path ||
      home;
    target = normalizeTarget(safe);
  }

  const info = await stat(target);
  if (!info.isDirectory()) {
    throw new Error(`Not a directory: ${target}`);
  }

  let names: string[] = [];
  try {
    names = await readdir(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read folder: ${message}`);
  }

  const entries: FsEntry[] = [];
  await Promise.all(
    names.map(async (name) => {
      if (name === "." || name === "..") return;
      // Skip known problematic localized shell folders on Windows.
      if (/^(Мои документы|My Documents|Application Data|Local Settings|Cookies|NetHood|PrintHood|Recent|SendTo|Шаблоны|Главное меню)$/i.test(name)) {
        return;
      }
      const full = join(target, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          if (!(await canListDirectory(full))) return;
          entries.push({ name, path: full, type: "dir" });
          return;
        }
        if (includeFiles && s.isFile()) {
          entries.push({ name, path: full, type: "file" });
        }
      } catch {
        /* skip inaccessible */
      }
    }),
  );

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return {
    path: target,
    parent: parentPath(target),
    entries,
    roots,
    shortcuts,
    warning,
  };
}
