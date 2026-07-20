import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./paths.js";

/** Session row without messages (messages live in `messages` table). */
export type StoredSessionMeta = {
  id: string;
  agentId: string;
  workspace: string;
  model: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode?: string;
  parentSessionId?: string;
  projectWorkspace?: string;
  agentBranch?: string;
  worktreePath?: string;
  agentBaseSha?: string;
  childStatus?: string;
  childSessionIds?: string[];
  skipParentWake?: boolean;
};

export type StoredSession = StoredSessionMeta & {
  messages: unknown[];
};

type JsonSessionFile = {
  version?: number;
  sessions?: Array<StoredSessionMeta & { messages?: unknown[] }>;
};

type MessageRow = { id: string; createdAt: number };

let db: DatabaseSync | null = null;

export function sessionsDbPath(): string {
  return join(dataDir(), "sessions.db");
}

function sessionsJsonPath(): string {
  return join(dataDir(), "sessions.json");
}

function sessionsJsonBackupPath(): string {
  return `${sessionsJsonPath()}.bak`;
}

function requireDb(): DatabaseSync {
  if (!db) throw new Error("Session store is not open");
  return db;
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      model TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      mode TEXT,
      parent_session_id TEXT,
      project_workspace TEXT,
      agent_branch TEXT,
      worktree_path TEXT,
      agent_base_sha TEXT,
      child_status TEXT,
      child_session_ids TEXT,
      skip_parent_wake INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_created
      ON messages(session_id, created_at);
  `);
}

function encodeIds(ids: string[] | undefined): string | null {
  if (!ids?.length) return null;
  return JSON.stringify(ids);
}

function decodeIds(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.filter((x): x is string => typeof x === "string");
    return ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

function rowToMeta(row: Record<string, unknown>): StoredSessionMeta {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    workspace: String(row.workspace),
    model: String(row.model),
    title: String(row.title),
    createdAt: Number(row.created_at) || Date.now(),
    updatedAt: Number(row.updated_at) || Date.now(),
    mode: typeof row.mode === "string" ? row.mode : undefined,
    parentSessionId:
      typeof row.parent_session_id === "string" ? row.parent_session_id : undefined,
    projectWorkspace:
      typeof row.project_workspace === "string" ? row.project_workspace : undefined,
    agentBranch: typeof row.agent_branch === "string" ? row.agent_branch : undefined,
    worktreePath: typeof row.worktree_path === "string" ? row.worktree_path : undefined,
    agentBaseSha: typeof row.agent_base_sha === "string" ? row.agent_base_sha : undefined,
    childStatus: typeof row.child_status === "string" ? row.child_status : undefined,
    childSessionIds: decodeIds(row.child_session_ids),
    skipParentWake: Number(row.skip_parent_wake) === 1 ? true : undefined,
  };
}

function withTransaction(fn: () => void): void {
  const database = requireDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    fn();
    database.exec("COMMIT");
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function openSessionStore(): void {
  if (db) return;
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(sessionsDbPath());
  initSchema(db);
}

export function closeSessionStore(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}

export function upsertSessionMeta(meta: StoredSessionMeta): void {
  const database = requireDb();
  database
    .prepare(
      `INSERT INTO sessions (
        id, agent_id, workspace, model, title, created_at, updated_at, mode,
        parent_session_id, project_workspace, agent_branch, worktree_path,
        agent_base_sha, child_status, child_session_ids, skip_parent_wake
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        workspace = excluded.workspace,
        model = excluded.model,
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        mode = excluded.mode,
        parent_session_id = excluded.parent_session_id,
        project_workspace = excluded.project_workspace,
        agent_branch = excluded.agent_branch,
        worktree_path = excluded.worktree_path,
        agent_base_sha = excluded.agent_base_sha,
        child_status = excluded.child_status,
        child_session_ids = excluded.child_session_ids,
        skip_parent_wake = excluded.skip_parent_wake`,
    )
    .run(
      meta.id,
      meta.agentId,
      meta.workspace,
      meta.model,
      meta.title,
      meta.createdAt,
      meta.updatedAt,
      meta.mode ?? null,
      meta.parentSessionId ?? null,
      meta.projectWorkspace ?? null,
      meta.agentBranch ?? null,
      meta.worktreePath ?? null,
      meta.agentBaseSha ?? null,
      meta.childStatus ?? null,
      encodeIds(meta.childSessionIds),
      meta.skipParentWake ? 1 : null,
    );
}

function upsertMessageRow(sessionId: string, message: MessageRow): void {
  const database = requireDb();
  database
    .prepare(
      `INSERT INTO messages (id, session_id, created_at, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    )
    .run(message.id, sessionId, message.createdAt, JSON.stringify(message));
}

export function upsertMessage(sessionId: string, message: MessageRow): void {
  upsertMessageRow(sessionId, message);
}

function replaceMessagesInner(sessionId: string, messages: MessageRow[]): void {
  const database = requireDb();
  database.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
  const insert = database.prepare(
    `INSERT INTO messages (id, session_id, created_at, payload) VALUES (?, ?, ?, ?)`,
  );
  for (const message of messages) {
    insert.run(message.id, sessionId, message.createdAt, JSON.stringify(message));
  }
}

export function replaceMessages(sessionId: string, messages: MessageRow[]): void {
  withTransaction(() => replaceMessagesInner(sessionId, messages));
}

export function deleteStoredSession(sessionId: string): void {
  requireDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

export function loadAllStoredSessions(): StoredSession[] {
  const database = requireDb();
  const sessionRows = database
    .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`)
    .all() as Record<string, unknown>[];
  const messageStmt = database.prepare(
    `SELECT payload FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
  );

  const out: StoredSession[] = [];
  for (const row of sessionRows) {
    const meta = rowToMeta(row);
    const msgRows = messageStmt.all(meta.id) as Array<{ payload: string }>;
    const messages: unknown[] = [];
    for (const msg of msgRows) {
      try {
        messages.push(JSON.parse(msg.payload));
      } catch {
        /* skip corrupt message row */
      }
    }
    out.push({ ...meta, messages });
  }
  return out;
}

function parseJsonSessions(raw: string): StoredSession[] {
  const parsed = JSON.parse(raw) as JsonSessionFile;
  const items = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const out: StoredSession[] = [];
  for (const item of items) {
    if (!item?.id || !item.agentId) continue;
    out.push({
      id: item.id,
      agentId: item.agentId,
      workspace: item.workspace,
      model: item.model,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      mode: item.mode,
      parentSessionId: item.parentSessionId,
      projectWorkspace: item.projectWorkspace,
      agentBranch: item.agentBranch,
      worktreePath: item.worktreePath,
      agentBaseSha: item.agentBaseSha,
      childStatus: item.childStatus,
      childSessionIds: item.childSessionIds,
      skipParentWake: item.skipParentWake,
      messages: Array.isArray(item.messages) ? item.messages : [],
    });
  }
  return out;
}

function asMessageRows(messages: unknown[]): MessageRow[] {
  const out: MessageRow[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as { id?: unknown; createdAt?: unknown };
    if (typeof rec.id !== "string") continue;
    const createdAt =
      typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)
        ? rec.createdAt
        : Date.now();
    out.push({ ...(m as object), id: rec.id, createdAt } as MessageRow);
  }
  return out;
}

function importSessions(items: StoredSession[]): number {
  withTransaction(() => {
    for (const item of items) {
      upsertSessionMeta(item);
      replaceMessagesInner(item.id, asMessageRows(item.messages));
    }
  });
  return items.length;
}

/**
 * Open DB and, if empty, migrate from sessions.json / .bak once.
 * Returns how many sessions are now in the store.
 */
export async function openAndMigrateSessionStore(): Promise<number> {
  await mkdir(dataDir(), { recursive: true });
  openSessionStore();

  const existing = loadAllStoredSessions();
  if (existing.length > 0) return existing.length;

  const candidates = [sessionsJsonPath(), sessionsJsonBackupPath()];
  let lastErr: unknown;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = await readFile(candidate, "utf8");
      const items = parseJsonSessions(raw);
      if (!items.length) continue;
      const count = importSessions(items);
      const migrated = `${candidate}.migrated`;
      try {
        await rename(candidate, migrated);
      } catch {
        console.warn(
          `Migrated ${count} session(s) from ${candidate} (could not rename file)`,
        );
      }
      console.info(`Migrated ${count} session(s) from ${candidate} → ${sessionsDbPath()}`);
      return count;
    } catch (err) {
      lastErr = err;
      console.error(`Failed to migrate sessions from ${candidate}:`, err);
    }
  }

  if (lastErr) {
    console.error("Session JSON migration failed; starting with empty store");
  }
  return 0;
}
