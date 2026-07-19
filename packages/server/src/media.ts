import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Readable } from "node:stream";
import { dataDir } from "./paths.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

const MEDIA_MIME = { ...IMAGE_MIME, ...VIDEO_MIME };

/** Common non-media types for download cards / Content-Type. */
const FILE_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8",
  ".c": "text/plain; charset=utf-8",
  ".cpp": "text/plain; charset=utf-8",
  ".h": "text/plain; charset=utf-8",
  ".hpp": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".env": "text/plain; charset=utf-8",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  ".apk": "application/vnd.android.package-archive",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".exe": "application/octet-stream",
  ".dll": "application/octet-stream",
  ".dmg": "application/octet-stream",
  ".iso": "application/octet-stream",
  ".sqlite": "application/x-sqlite3",
  ".db": "application/octet-stream",
};

const ALL_MIME = { ...MEDIA_MIME, ...FILE_MIME };

/** Virtual path prefix for chat-only previews / downloads (not project files). */
export const CHAT_MEDIA_PREFIX = "chat-media/";

/** Max file size served through media API (100 MB). */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export function isImagePath(filePath: string): boolean {
  return Boolean(IMAGE_MIME[extname(filePath).toLowerCase()]);
}

export function isVideoPath(filePath: string): boolean {
  return Boolean(VIDEO_MIME[extname(filePath).toLowerCase()]);
}

export function isMediaPath(filePath: string): boolean {
  return Boolean(MEDIA_MIME[extname(filePath).toLowerCase()]);
}

export function mediaMimeType(filePath: string): string {
  return ALL_MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function mediaKind(filePath: string): "image" | "video" | "file" {
  if (isVideoPath(filePath)) return "video";
  if (isImagePath(filePath)) return "image";
  return "file";
}

/** RFC 5987 Content-Disposition filename* helper. */
export function contentDispositionAttachment(fileName: string): string {
  const base = basename(fileName.trim() || "download");
  const ascii = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(base);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function normalizeRoot(root: string): string {
  return resolve(root.trim());
}

/** True if `absolute` is inside `root` (or is root). Windows-safe. */
export function isPathInsideRoot(root: string, absolute: string): boolean {
  const base = normalizeRoot(root);
  const target = resolve(absolute);
  if (process.platform === "win32") {
    const rootLower = base.toLowerCase();
    const targetLower = target.toLowerCase();
    if (targetLower === rootLower) return true;
    const prefix = rootLower.endsWith(sep) ? rootLower : rootLower + sep;
    return targetLower.startsWith(prefix);
  }
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

/** @deprecated use isPathInsideRoot */
export function isPathInsideWorkspace(workspace: string, absolute: string): boolean {
  return isPathInsideRoot(workspace, absolute);
}

export function sessionMediaDir(sessionId: string): string {
  return join(dataDir(), "sessions", sessionId, "media");
}

function stripQuotes(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith("`") && s.endsWith("`")) ||
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//i, ""));
      if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
    } catch {
      s = s.replace(/^file:\/\//i, "");
    }
  }
  return s;
}

export type ResolvedMedia = {
  absolute: string;
  relativePath: string;
  mimeType: string;
  size: number;
  kind: "image" | "video" | "file";
};

async function tryStatFile(absolute: string): Promise<{ size: number } | null> {
  try {
    await access(absolute, constants.R_OK);
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    return { size: info.size };
  } catch {
    return null;
  }
}

async function findByBasename(dir: string, fileName: string): Promise<string | null> {
  try {
    const names = await readdir(dir);
    const lower = fileName.toLowerCase();
    const hit = names.find((n) => n.toLowerCase() === lower);
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

/** Shallow-ish walk for a basename under workspace (skips heavy dirs). */
async function findInWorkspaceTree(
  root: string,
  fileName: string,
  maxFiles = 800,
): Promise<string | null> {
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".cursor",
  ]);
  const lower = fileName.toLowerCase();
  const queue: string[] = [root];
  let seen = 0;

  while (queue.length > 0 && seen < maxFiles) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== fileName) {
        if (entry.isDirectory() && skip.has(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        queue.push(join(dir, entry.name));
        continue;
      }
      seen += 1;
      if (entry.name.toLowerCase() === lower) {
        return join(dir, entry.name);
      }
      if (seen >= maxFiles) break;
    }
  }
  return null;
}

function finalizeResolved(
  absolute: string,
  relativePath: string,
  size: number,
): ResolvedMedia {
  if (size > MAX_MEDIA_BYTES) {
    throw new Error(`File too large (max ${MAX_MEDIA_BYTES} bytes)`);
  }
  return {
    absolute,
    relativePath: relativePath.split(sep).join("/"),
    mimeType: mediaMimeType(absolute),
    size,
    kind: mediaKind(absolute),
  };
}

/**
 * Resolve media/files for a chat session.
 * Order: session chat-media store → absolute host path → workspace relative path.
 */
export async function resolveSessionMedia(
  sessionId: string,
  workspace: string,
  rawPath: string,
): Promise<ResolvedMedia> {
  const cleaned = stripQuotes(rawPath).replace(/\\/g, "/");
  if (!cleaned) throw new Error("path is required");

  const mediaRoot = sessionMediaDir(sessionId);
  const workspaceRoot = normalizeRoot(workspace);

  // chat-media/... or bare basename → session store
  const chatRel = cleaned.toLowerCase().startsWith(CHAT_MEDIA_PREFIX)
    ? cleaned.slice(CHAT_MEDIA_PREFIX.length)
    : cleaned.includes("/") || cleaned.includes(":")
      ? null
      : cleaned;

  if (chatRel != null && chatRel && !chatRel.includes("..")) {
    let absolute = resolve(mediaRoot, chatRel);
    let info = await tryStatFile(absolute);
    if (!info) {
      const fallback = await findByBasename(mediaRoot, basename(chatRel));
      if (fallback) {
        absolute = fallback;
        info = await tryStatFile(absolute);
      }
    }
    if (info && isPathInsideRoot(mediaRoot, absolute)) {
      return finalizeResolved(
        absolute,
        `${CHAT_MEDIA_PREFIX}${relative(mediaRoot, absolute)}`,
        info.size,
      );
    }
    // If caller used chat-media/ prefix, don't fall through to workspace for that virtual path.
    if (cleaned.toLowerCase().startsWith(CHAT_MEDIA_PREFIX)) {
      throw new Error("File not found");
    }
  }

  // Also try basename in session media (agent linked captures/foo.png but we stored chat-media/foo.png)
  // Skip for absolute host paths — those must resolve to the exact file.
  const looksAbsolute =
    isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned) || cleaned.startsWith("//");
  if (!looksAbsolute) {
    const fallback = await findByBasename(mediaRoot, basename(cleaned));
    if (fallback) {
      const info = await tryStatFile(fallback);
      if (info && isPathInsideRoot(mediaRoot, fallback)) {
        return finalizeResolved(
          fallback,
          `${CHAT_MEDIA_PREFIX}${relative(mediaRoot, fallback)}`,
          info.size,
        );
      }
    }
  }

  // Absolute path anywhere on the host (auth-gated).
  if (looksAbsolute) {
    const absCandidate = resolve(cleaned);
    const absInfo = await tryStatFile(absCandidate);
    if (!absInfo) throw new Error("File not found");
    return finalizeResolved(
      absCandidate,
      absCandidate.split(sep).join("/"),
      absInfo.size,
    );
  }

  // Relative path → workspace (with light basename fallbacks)
  let absolute = resolve(workspaceRoot, cleaned);
  let info = await tryStatFile(absolute);
  if (!info) {
    const capturesHit = await findByBasename(join(workspaceRoot, "captures"), basename(cleaned));
    if (capturesHit) {
      absolute = capturesHit;
      info = await tryStatFile(absolute);
    }
  }
  if (!info) {
    const treeHit = await findInWorkspaceTree(workspaceRoot, basename(cleaned));
    if (treeHit) {
      absolute = treeHit;
      info = await tryStatFile(absolute);
    }
  }

  if (!info) throw new Error("File not found");
  if (!isPathInsideRoot(workspaceRoot, absolute)) {
    throw new Error("Path is outside the session workspace");
  }

  let relativePath = relative(workspaceRoot, absolute);
  if (!relativePath || relativePath.startsWith("..")) {
    relativePath = absolute;
  }
  return finalizeResolved(absolute, relativePath, info.size);
}

/** @deprecated use resolveSessionMedia */
export async function resolveWorkspaceMedia(
  workspace: string,
  rawPath: string,
): Promise<ResolvedMedia> {
  return resolveSessionMedia("_legacy", workspace, rawPath);
}

/** @deprecated use resolveSessionMedia */
export async function resolveWorkspaceImage(
  workspace: string,
  rawPath: string,
): Promise<ResolvedMedia> {
  const media = await resolveWorkspaceMedia(workspace, rawPath);
  if (media.kind !== "image") throw new Error("Only image files are supported");
  return media;
}

export function openMediaStream(absolutePath: string, start = 0, end?: number): Readable {
  if (start > 0 || end != null) {
    return createReadStream(absolutePath, {
      start,
      end: end ?? undefined,
    });
  }
  return createReadStream(absolutePath);
}

function sanitizeFileName(name: string): string {
  const base = basename(name.trim() || "download");
  const cleaned = base.replace(/[^\w.\-()+@]/g, "_");
  return cleaned || "download";
}

/**
 * Ensure a usable filename. When `fallbackExt` is set and the name has no
 * extension, append it (used for generated images). When omitted, keep the
 * original name so arbitrary files (pdf/zip/…) stay downloadable.
 */
function ensureFileName(fileName: string, fallbackExt?: string): string {
  if (extname(fileName)) return fileName;
  if (!fallbackExt) return fileName || "download";
  const ext = fallbackExt.startsWith(".") ? fallbackExt : `.${fallbackExt}`;
  return `${fileName || "download"}${ext}`;
}

/**
 * Store a file in the session data dir (not the project workspace).
 * Returns a virtual path like `chat-media/shot-01.png` or `chat-media/report.pdf`.
 */
export async function ingestSessionMedia(
  sessionId: string,
  options: {
    sourcePath?: string;
    imageData?: string;
    preferredName?: string;
    /** Appended only when the preferred/source name has no extension. */
    fallbackExt?: string;
  },
): Promise<string> {
  const mediaRoot = sessionMediaDir(sessionId);
  await mkdir(mediaRoot, { recursive: true });

  const preferred = options.preferredName ? stripQuotes(options.preferredName) : "";
  const fromSource = options.sourcePath ? basename(stripQuotes(options.sourcePath)) : "";
  const fileName = ensureFileName(
    sanitizeFileName(preferred || fromSource || `gen-${Date.now()}`),
    options.fallbackExt,
  );
  const destAbs = resolve(mediaRoot, fileName);
  if (!isPathInsideRoot(mediaRoot, destAbs)) {
    throw new Error("Refusing to write media outside session media dir");
  }
  await mkdir(dirname(destAbs), { recursive: true });

  if (options.sourcePath) {
    const src = resolve(stripQuotes(options.sourcePath));
    const info = await tryStatFile(src);
    if (info) {
      if (info.size > MAX_MEDIA_BYTES) {
        throw new Error(`File too large (max ${MAX_MEDIA_BYTES} bytes)`);
      }
      await copyFile(src, destAbs);
      return `${CHAT_MEDIA_PREFIX}${fileName}`;
    }
  }

  if (options.imageData) {
    let b64 = options.imageData.trim();
    const dataUrl = /^data:[^;]+;base64,(.+)$/i.exec(b64);
    if (dataUrl) b64 = dataUrl[1] || b64;
    const buf = Buffer.from(b64, "base64");
    if (buf.length > MAX_MEDIA_BYTES) {
      throw new Error(`File too large (max ${MAX_MEDIA_BYTES} bytes)`);
    }
    await writeFile(destAbs, buf);
    return `${CHAT_MEDIA_PREFIX}${fileName}`;
  }

  throw new Error("No media content to ingest");
}

/** @deprecated use ingestSessionMedia */
export async function ingestMediaToWorkspace(
  workspace: string,
  options: {
    sourcePath?: string;
    imageData?: string;
    preferredPath?: string;
    fallbackExt?: string;
  },
): Promise<string> {
  void workspace;
  return ingestSessionMedia("legacy", {
    sourcePath: options.sourcePath,
    imageData: options.imageData,
    preferredName: options.preferredPath,
    fallbackExt: options.fallbackExt,
  });
}

/** Merge thinking chunks that may be deltas or cumulative snapshots. */
export function mergeThinkingText(buffer: string, chunk: string): string {
  if (!chunk) return buffer;
  if (!buffer) return chunk;
  if (chunk === buffer) return buffer;
  if (chunk.startsWith(buffer)) return chunk;
  if (buffer.startsWith(chunk)) return buffer;
  if (buffer.endsWith(chunk)) return buffer;
  const max = Math.min(buffer.length, chunk.length);
  for (let n = max; n > 0; n -= 1) {
    if (buffer.endsWith(chunk.slice(0, n))) {
      return buffer + chunk.slice(n);
    }
  }
  return buffer + chunk;
}
