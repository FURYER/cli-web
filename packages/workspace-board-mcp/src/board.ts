import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type BoardColumn = {
  id: string;
  title: string;
  order: number;
};

export type BoardCard = {
  id: string;
  columnId: string;
  title: string;
  body: string;
  order: number;
  createdAt: number;
  updatedAt: number;
};

export type Board = {
  version: 1;
  nextId: number;
  columns: BoardColumn[];
  cards: BoardCard[];
};

export function boardPath(workspace: string): string {
  return join(workspace, ".webcli", "board.json");
}

function legacyBoardPath(workspace: string): string {
  return join(workspace, ".cursor-cli", "board.json");
}

/** Prefer .webcli/board.json; migrate once from legacy .cursor-cli/board.json. */
async function resolveBoardPath(workspace: string): Promise<string> {
  const next = boardPath(workspace);
  if (existsSync(next)) return next;
  const legacy = legacyBoardPath(workspace);
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
        }))
    : [];

  const nextId =
    typeof o.nextId === "number" && Number.isFinite(o.nextId) && o.nextId > 0
      ? Math.floor(o.nextId)
      : Math.max(
          1,
          ...cards.map((c) => {
            const m = /^T-(\d+)$/.exec(c.id);
            return m ? Number(m[1]) + 1 : 1;
          }),
        );

  return { version: 1, nextId, columns, cards };
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

function requireWorkspace(workspace: string): string {
  const ws = workspace.trim();
  if (!ws) throw new Error("workspace is required (absolute path to project root)");
  return ws;
}

export async function loadBoard(workspace: string): Promise<Board> {
  const ws = requireWorkspace(workspace);
  const file = await resolveBoardPath(ws);
  try {
    const text = await readFile(file, "utf8");
    return normalizeBoard(JSON.parse(text) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    const board = defaultBoard();
    await saveBoard(ws, board);
    return board;
  }
}

export async function saveBoard(workspace: string, board: Board): Promise<Board> {
  const ws = requireWorkspace(workspace);
  const normalized = normalizeBoard(board);
  const file = await resolveBoardPath(ws);
  await atomicWrite(file, JSON.stringify(normalized, null, 2));
  return normalized;
}

export async function addColumn(workspace: string, title: string): Promise<Board> {
  const board = await loadBoard(workspace);
  const order = board.columns.reduce((m, c) => Math.max(m, c.order), -1) + 1;
  board.columns.push({
    id: `col_${randomUUID().slice(0, 8)}`,
    title: title.trim() || "Column",
    order,
  });
  return saveBoard(workspace, board);
}

export async function renameColumn(
  workspace: string,
  columnId: string,
  title: string,
): Promise<Board> {
  const board = await loadBoard(workspace);
  const col = board.columns.find((c) => c.id === columnId);
  if (!col) throw new Error("Column not found");
  const t = title.trim();
  if (!t) throw new Error("Column title is required");
  col.title = t;
  return saveBoard(workspace, board);
}

export async function deleteColumn(workspace: string, columnId: string): Promise<Board> {
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
  const order =
    board.cards
      .filter((c) => c.columnId === columnId)
      .reduce((m, c) => Math.max(m, c.order), -1) + 1;
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

export async function updateCard(
  workspace: string,
  cardId: string,
  patch: { title?: string; body?: string },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const card = board.cards.find((c) => c.id === cardId || c.id === cardId.replace(/^#/, ""));
  if (!card) throw new Error("Card not found");
  if (typeof patch.title === "string") {
    const t = patch.title.trim();
    if (!t) throw new Error("Card title is required");
    card.title = t;
  }
  if (typeof patch.body === "string") card.body = patch.body;
  card.updatedAt = Date.now();
  return saveBoard(workspace, board);
}

export async function moveCard(
  workspace: string,
  cardId: string,
  input: { columnId: string; order?: number },
): Promise<Board> {
  const board = await loadBoard(workspace);
  const id = cardId.replace(/^#/, "");
  const card = board.cards.find((c) => c.id === id);
  if (!card) throw new Error("Card not found");
  if (!board.columns.some((c) => c.id === input.columnId)) {
    throw new Error("Column not found");
  }
  card.columnId = input.columnId;
  if (typeof input.order === "number" && Number.isFinite(input.order)) {
    card.order = input.order;
  } else {
    card.order =
      board.cards
        .filter((c) => c.columnId === input.columnId && c.id !== id)
        .reduce((m, c) => Math.max(m, c.order), -1) + 1;
  }
  card.updatedAt = Date.now();
  return saveBoard(workspace, board);
}

export async function deleteCard(workspace: string, cardId: string): Promise<Board> {
  const board = await loadBoard(workspace);
  const id = cardId.replace(/^#/, "");
  const before = board.cards.length;
  board.cards = board.cards.filter((c) => c.id !== id);
  if (board.cards.length === before) throw new Error("Card not found");
  return saveBoard(workspace, board);
}

export function summarizeBoard(board: Board): string {
  const cols = [...board.columns].sort((a, b) => a.order - b.order);
  const lines: string[] = [`Board nextId=${board.nextId}`, ""];
  for (const col of cols) {
    const cards = board.cards
      .filter((c) => c.columnId === col.id)
      .sort((a, b) => a.order - b.order);
    lines.push(`## ${col.title} (${col.id})`);
    if (cards.length === 0) lines.push("- (empty)");
    for (const card of cards) {
      lines.push(`- ${card.id}: ${card.title}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
