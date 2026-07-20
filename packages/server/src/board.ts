import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  boardFilePath,
  boardFilesDir,
  legacyBoardFilePath,
} from "./paths.js";
import { isPathInsideRoot, MAX_MEDIA_BYTES } from "./media.js";

export type BoardColumn = {
  id: string;
  title: string;
  order: number;
};

export type BoardAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Absolute path under workspace .webcli/board-files/… */
  path: string;
  createdAt: number;
};

export type BoardCard = {
  id: string;
  columnId: string;
  title: string;
  body: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  attachments?: BoardAttachment[];
};

export type Board = {
  version: 1;
  nextId: number;
  columns: BoardColumn[];
  cards: BoardCard[];
};

type BoardBroadcaster = (event: {
  type: "board_updated";
  workspace: string;
  board: Board;
}) => void;

let broadcastBoard: BoardBroadcaster = () => {};

export function setBoardBroadcaster(fn: BoardBroadcaster): void {
  broadcastBoard = fn;
}

/** Prefer .webcli/board.json; migrate once from legacy .cursor-cli/board.json. */
async function resolveBoardPath(workspace: string): Promise<string> {
  const next = boardFilePath(workspace);
  if (existsSync(next)) return next;
  const legacy = legacyBoardFilePath(workspace);
  if (existsSync(legacy)) {
    await mkdir(dirname(next), { recursive: true });
    await rename(legacy, next);
    return next;
  }
  return next;
}

function defaultBoard(): Board {
  return {
    version: 1,
    nextId: 1,
    columns: [
      { id: "col_inbox", title: "Inbox", order: 0 },
      { id: "col_doing", title: "In progress", order: 1 },
      { id: "col_done", title: "Done", order: 2 },
    ],
    cards: [],
  };
}

function normalizeBoard(raw: unknown): Board {
  if (!raw || typeof raw !== "object") return defaultBoard();
  const o = raw as Record<string, unknown>;
  const columns = Array.isArray(o.columns)
    ? o.columns
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c, i) => ({
          id: typeof c.id === "string" && c.id ? c.id : `col_${randomUUID().slice(0, 8)}`,
          title: typeof c.title === "string" && c.title.trim() ? c.title.trim() : "Column",
          order: typeof c.order === "number" && Number.isFinite(c.order) ? c.order : i,
        }))
        .sort((a, b) => a.order - b.order)
    : defaultBoard().columns;

  const cards = Array.isArray(o.cards)
    ? o.cards
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c, i) => ({
          id: typeof c.id === "string" && c.id ? c.id : `T-${i + 1}`,
          columnId:
            typeof c.columnId === "string" && c.columnId
              ? c.columnId
              : columns[0]?.id || "col_inbox",
          title: typeof c.title === "string" ? c.title : "",
          body: typeof c.body === "string" ? c.body : "",
          order: typeof c.order === "number" && Number.isFinite(c.order) ? c.order : i,
          createdAt:
            typeof c.createdAt === "number" && Number.isFinite(c.createdAt)
              ? c.createdAt
              : Date.now(),
          updatedAt:
            typeof c.updatedAt === "number" && Number.isFinite(c.updatedAt)
              ? c.updatedAt
              : Date.now(),
          attachments: normalizeAttachments(c.attachments),
        }))
    : [];

  const nextId =
    typeof o.nextId === "number" && Number.isFinite(o.nextId) && o.nextId > 0
      ? Math.floor(o.nextId)
      : Math.max(1, ...cards.map((c) => {
          const m = /^T-(\d+)$/.exec(c.id);
          return m ? Number(m[1]) + 1 : 1;
        }));

  return { version: 1, nextId, columns, cards };
}

function normalizeAttachments(raw: unknown): BoardAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: BoardAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id) continue;
    if (typeof a.path !== "string" || !a.path) continue;
    out.push({
      id: a.id,
      name: typeof a.name === "string" && a.name ? a.name : basename(a.path),
      mimeType: typeof a.mimeType === "string" && a.mimeType ? a.mimeType : "application/octet-stream",
      size: typeof a.size === "number" && Number.isFinite(a.size) ? a.size : 0,
      path: a.path,
      createdAt:
        typeof a.createdAt === "number" && Number.isFinite(a.createdAt)
          ? a.createdAt
          : Date.now(),
    });
  }
  return out.length ? out : undefined;
}

function sanitizeBoardFileName(name: string): string {
  const base = basename(name.trim() || "file");
  return base.replace(/[^\w.\-()+@]/g, "_") || "file";
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

export async function loadBoard(workspace: string): Promise<Board> {
  const ws = workspace.trim();
  if (!ws) throw new Error("workspace is required");
  const file = await resolveBoardPath(ws);
  try {
    const text = await readFile(file, "utf8");
    return normalizeBoard(JSON.parse(text) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    const board = defaultBoard();
    await saveBoard(ws, board, { silent: true });
    return board;
  }
}

export async function saveBoard(
  workspace: string,
  board: Board,
  options?: { silent?: boolean },
): Promise<Board> {
  const ws = workspace.trim();
  if (!ws) throw new Error("workspace is required");
  const normalized = normalizeBoard(board);
  const file = await resolveBoardPath(ws);
  await atomicWrite(file, JSON.stringify(normalized, null, 2));
  if (!options?.silent) {
    broadcastBoard({ type: "board_updated", workspace: ws, board: normalized });
  }
  return normalized;
}

export async function putBoard(workspace: string, board: Board): Promise<Board> {
  return saveBoard(workspace, board);
}

export async function addColumn(
  workspace: string,
  title: string,
): Promise<Board> {
  const board = await loadBoard(workspace);
  const order = board.columns.reduce((m, c) => Math.max(m, c.order), -1) + 1;
  board.columns.push({
    id: `col_${randomUUID().slice(0, 8)}`,
    title: title.trim() || "Column",
    order,
  });
  return saveBoard(workspace, board);
}

export async function patchColumn(
  workspace: string,
  columnId: string,
  patch: { title?: string; order?: number },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const col = board.columns.find((c) => c.id === columnId);
  if (!col) throw new Error("Column not found");
  if (typeof patch.title === "string" && patch.title.trim()) col.title = patch.title.trim();
  if (typeof patch.order === "number" && Number.isFinite(patch.order)) col.order = patch.order;
  return saveBoard(workspace, board);
}

export async function deleteColumn(
  workspace: string,
  columnId: string,
): Promise<Board> {
  const board = await loadBoard(workspace);
  if (board.columns.length <= 1) throw new Error("Cannot delete the last column");
  const fallback = board.columns.find((c) => c.id !== columnId);
  if (!fallback) throw new Error("Cannot delete the last column");
  board.columns = board.columns.filter((c) => c.id !== columnId);
  for (const card of board.cards) {
    if (card.columnId === columnId) {
      card.columnId = fallback.id;
      card.updatedAt = Date.now();
    }
  }
  return saveBoard(workspace, board);
}

export async function addCard(
  workspace: string,
  input: { title: string; body?: string; columnId?: string },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const columnId =
    input.columnId && board.columns.some((c) => c.id === input.columnId)
      ? input.columnId
      : board.columns.slice().sort((a, b) => a.order - b.order)[0]?.id;
  if (!columnId) throw new Error("No columns on board");
  const title = input.title.trim();
  if (!title) throw new Error("Card title is required");
  const now = Date.now();
  const inColumn = board.cards.filter((c) => c.columnId === columnId);
  const order = inColumn.length
    ? Math.min(...inColumn.map((c) => c.order)) - 1
    : 0;
  const id = `T-${board.nextId}`;
  board.nextId += 1;
  board.cards.push({
    id,
    columnId,
    title,
    body: (input.body ?? "").trim(),
    order,
    createdAt: now,
    updatedAt: now,
  });
  return saveBoard(workspace, board);
}

export async function patchCard(
  workspace: string,
  cardId: string,
  patch: { title?: string; body?: string; columnId?: string; order?: number },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Card not found");
  if (typeof patch.title === "string") {
    const t = patch.title.trim();
    if (!t) throw new Error("Card title is required");
    card.title = t;
  }
  if (typeof patch.body === "string") card.body = patch.body;
  if (typeof patch.columnId === "string") {
    if (!board.columns.some((c) => c.id === patch.columnId)) {
      throw new Error("Column not found");
    }
    card.columnId = patch.columnId;
  }
  if (typeof patch.order === "number" && Number.isFinite(patch.order)) {
    card.order = patch.order;
  }
  card.updatedAt = Date.now();
  return saveBoard(workspace, board);
}

export async function deleteCard(
  workspace: string,
  cardId: string,
): Promise<Board> {
  const board = await loadBoard(workspace);
  const before = board.cards.length;
  board.cards = board.cards.filter((c) => c.id !== cardId);
  if (board.cards.length === before) throw new Error("Card not found");
  const filesDir = boardFilesDir(workspace, cardId);
  if (existsSync(filesDir)) {
    await rm(filesDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return saveBoard(workspace, board);
}

export async function addCardAttachment(
  workspace: string,
  cardId: string,
  input: { name: string; mimeType: string; data: string },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Card not found");

  const buf = Buffer.from(input.data, "base64");
  if (!buf.length) throw new Error("Empty attachment");
  if (buf.length > MAX_MEDIA_BYTES) {
    throw new Error(`File too large (max ${MAX_MEDIA_BYTES} bytes)`);
  }

  const attId = `att_${randomUUID().slice(0, 10)}`;
  const safeName = sanitizeBoardFileName(input.name);
  const dir = boardFilesDir(workspace, cardId);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, `${attId}-${safeName}`);
  if (!isPathInsideRoot(boardFilesDir(workspace), abs)) {
    throw new Error("Invalid attachment path");
  }
  await writeFile(abs, buf);

  const attachment: BoardAttachment = {
    id: attId,
    name: input.name.trim() || safeName,
    mimeType: input.mimeType.trim() || "application/octet-stream",
    size: buf.length,
    path: abs,
    createdAt: Date.now(),
  };
  card.attachments = [...(card.attachments || []), attachment];
  card.updatedAt = Date.now();
  return saveBoard(workspace, board);
}

export async function removeCardAttachment(
  workspace: string,
  cardId: string,
  attachmentId: string,
): Promise<Board> {
  const board = await loadBoard(workspace);
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Card not found");
  const att = card.attachments?.find((a) => a.id === attachmentId);
  if (!att) throw new Error("Attachment not found");
  card.attachments = (card.attachments || []).filter((a) => a.id !== attachmentId);
  if (!card.attachments.length) delete card.attachments;
  card.updatedAt = Date.now();
  if (existsSync(att.path) && isPathInsideRoot(boardFilesDir(workspace), att.path)) {
    await rm(att.path, { force: true }).catch(() => undefined);
  }
  return saveBoard(workspace, board);
}

export function getCardAttachment(
  board: Board,
  cardId: string,
  attachmentId: string,
): BoardAttachment {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Card not found");
  const att = card.attachments?.find((a) => a.id === attachmentId);
  if (!att) throw new Error("Attachment not found");
  return att;
}

export async function moveCard(
  workspace: string,
  cardId: string,
  input: { columnId: string; order?: number },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Card not found");
  if (!board.columns.some((c) => c.id === input.columnId)) {
    throw new Error("Column not found");
  }
  const order =
    typeof input.order === "number" && Number.isFinite(input.order)
      ? input.order
      : (() => {
          const inColumn = board.cards.filter(
            (c) => c.columnId === input.columnId && c.id !== cardId,
          );
          return inColumn.length
            ? Math.min(...inColumn.map((c) => c.order)) - 1
            : 0;
        })();
  return patchCard(workspace, cardId, {
    columnId: input.columnId,
    order,
  });
}
