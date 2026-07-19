import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Agent,
  type AgentModeOption,
  type Run,
  type SDKAgent,
  type SDKAgentInfo,
  type SDKMessage,
  type TokenUsage,
} from "@cursor/sdk";
import { createCheckpoint, restoreCheckpoint } from "./git-checkpoint.js";
import {
  buildContextSnapshot,
  CONTEXT_WINDOW_TOKENS,
  promptTokensFromUsage,
  type ContextSnapshot,
} from "./context-usage.js";
import { ingestSessionMedia, isMediaPath, mergeThinkingText } from "./media.js";
import { loadMcpServers } from "./mcp.js";
import { createAskUserCustomTool } from "./ask-user-tool.js";
import { createSubagentTools } from "./delegate-tools.js";
import { notifyDeployIdleCheck } from "./deploy.js";
import { dataDir, requireAgentApiKey } from "./paths.js";
import { notifyAgentFinished } from "./push.js";
import {
  answerAskQuestion as resolveAskQuestion,
  beginAskSession,
  cancelAskQuestionsForSession,
  clearAskWaitPause,
  askWaitPausedMs,
  endAskSession,
  type AskQuestionAnswer,
  type AskQuestionHandlerResult,
  type AskQuestionItem,
  runWithAskSession,
} from "./ask-question.js";

export type { ContextCategory, ContextSnapshot } from "./context-usage.js";
export { CONTEXT_WINDOW_TOKENS } from "./context-usage.js";
export type {
  AskQuestionAnswer,
  AskQuestionHandlerResult,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionPrompt,
} from "./ask-question.js";

export type ActivityKind = "thinking" | "tool" | "step" | "summary" | "task" | "usage";

export type ChatImage = {
  mimeType: string;
  /** data URL for UI / persistence */
  dataUrl: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "activity" | "question";
  content: string;
  toolName?: string;
  createdAt: number;
  activityId?: string;
  activityKind?: ActivityKind;
  activityStatus?: "running" | "completed" | "error";
  durationMs?: number;
  detail?: string;
  /** Workspace-relative or absolute path for edit/write/delete tools. */
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
  linesCreated?: number;
  /** Git commit-ish of the workspace before this user turn. */
  checkpointSha?: string;
  /** Agent mode used for this user turn. */
  mode?: AgentModeOption;
  images?: ChatImage[];
  usage?: TokenUsage;
  context?: ContextSnapshot;
  /** Interactive Ask Question card (pending cards are live WS-only). */
  questionTitle?: string;
  questionItems?: AskQuestionItem[];
  questionStatus?: "answered" | "skipped";
  questionAnswers?: AskQuestionAnswer[];
  questionCallId?: string;
};

export type ChildAgentStatus = "running" | "done" | "error" | "merged" | "conflict";

export type SessionSummary = {
  id: string;
  agentId: string;
  workspace: string;
  model: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  mode?: AgentModeOption;
  /** True while a send/run is in flight for this session. */
  busy?: boolean;
  /** Parent orchestrator session (sub-agent chats). */
  parentSessionId?: string;
  /**
   * Project root for UI grouping / board. For sub-agents this is the parent
   * workspace; agent cwd remains `workspace` (worktree path).
   */
  projectWorkspace?: string;
  /** Git branch for this sub-agent worktree. */
  agentBranch?: string;
  /** Absolute worktree path (sub-agents only). */
  worktreePath?: string;
  /** Base commit when the worktree was created. */
  agentBaseSha?: string;
  /** Lifecycle for delegated children. */
  childStatus?: ChildAgentStatus;
  /** Direct child session ids (orchestrator). */
  childSessionIds?: string[];
  /** If true, finishing this child does not auto-wake the parent (wait:true spawn). */
  skipParentWake?: boolean;
};

export type SessionRecord = SessionSummary & {
  agent: SDKAgent | null;
  messages: ChatMessage[];
  /** True while a send/run is in flight. */
  busy?: boolean;
  /** Wall clock when busy flipped true — prepare phase has no activeRun yet. */
  busyStartedAt?: number;
  activeRun?: Run | null;
  mode?: AgentModeOption;
};

type PersistedSession = Omit<
  SessionRecord,
  "agent" | "messageCount" | "busy" | "busyStartedAt" | "activeRun"
>;

/** How long we may wait for checkpoint / ensureAgent / send before treating as stuck. */
const BUSY_PREPARE_GRACE_MS = 5 * 60 * 1000;

function setSessionBusy(session: SessionRecord, busy: boolean): void {
  session.busy = busy;
  if (busy) {
    session.busyStartedAt = Date.now();
  } else {
    delete session.busyStartedAt;
    clearAskWaitPause(session.id);
  }
}

type ParentWakeItem = {
  childSessionId: string;
  status: ChildAgentStatus;
};

/** Coalesced wake-ups: child done → parent gets one turn with all results. */
const parentWakeQueue = new Map<string, ParentWakeItem[]>();
const parentWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const parentWakeInFlight = new Set<string>();

type SessionSendSource = "user" | "wake" | "system";

type SessionSendRequest = {
  text: string;
  options?: {
    modelId?: string;
    mode?: AgentModeOption;
    images?: SendImageInput[];
  };
  source: SessionSendSource;
  resolve?: () => void;
  reject?: (err: Error) => void;
};

/**
 * FIFO send queue per session. User messages jump ahead of pending wake/system
 * items so a human turn is not lost behind auto-orchestration.
 */
const sessionSendQueues = new Map<string, SessionSendRequest[]>();
const sessionSendPumping = new Set<string>();

function markChildRunFinished(session: SessionRecord, status: string): void {
  if (!session.parentSessionId) return;
  const ok =
    status === "finished" || status === "completed" || status === "success";
  session.childStatus = ok ? "done" : "error";
  session.updatedAt = Date.now();
  schedulePersist();
  broadcast({
    type: "child_agent",
    sessionId: session.parentSessionId,
    childSessionId: session.id,
    status: session.childStatus,
    title: session.title,
    branch: session.agentBranch,
  });
  if (!session.skipParentWake) {
    enqueueParentWake(session.parentSessionId, {
      childSessionId: session.id,
      status: session.childStatus,
    });
  }
}

function enqueueParentWake(parentSessionId: string, item: ParentWakeItem): void {
  const prev = parentWakeQueue.get(parentSessionId) ?? [];
  const next = prev.filter((x) => x.childSessionId !== item.childSessionId);
  next.push(item);
  parentWakeQueue.set(parentSessionId, next);

  const existing = parentWakeTimers.get(parentSessionId);
  if (existing) clearTimeout(existing);
  // Debounce so parallel finishers coalesce into one orchestrator turn.
  parentWakeTimers.set(
    parentSessionId,
    setTimeout(() => {
      parentWakeTimers.delete(parentSessionId);
      void flushParentWake(parentSessionId);
    }, 1500),
  );
}

function parentHasRunningChildren(parent: SessionRecord): boolean {
  for (const id of parent.childSessionIds || []) {
    const child = sessions.get(id);
    if (!child) continue;
    if (child.busy || child.childStatus === "running") return true;
  }
  return false;
}

async function buildParentWakePrompt(
  parent: SessionRecord,
  items: ParentWakeItem[],
): Promise<string> {
  const lines: string[] = [
    "System: delegated sub-agents finished. Continue the orchestration automatically.",
    "Review each result, call `merge_child` for successful work (sensible order),",
    "use `ask_user` on conflicts, and fix/re-delegate only what failed.",
    "Do not re-delegate tasks that already succeeded.",
    "",
    "## Finished children",
  ];

  for (const item of items) {
    const child = sessions.get(item.childSessionId);
    lines.push("");
    lines.push(`### ${child?.title || item.childSessionId}`);
    lines.push(`- childSessionId: \`${item.childSessionId}\``);
    lines.push(`- status: **${item.status}**`);
    if (child?.agentBranch) lines.push(`- branch: \`${child.agentBranch}\``);

    try {
      const detail = await getDelegatedChildResult(parent.id, item.childSessionId);
      if (detail.branchSummary) {
        lines.push("");
        lines.push("Branch summary:");
        lines.push("```");
        lines.push(detail.branchSummary.slice(0, 3000));
        lines.push("```");
      }
      if (detail.lastAssistant) {
        lines.push("");
        lines.push("Last assistant message:");
        lines.push(detail.lastAssistant.slice(0, 4000));
      }
    } catch (err) {
      lines.push(
        `- (could not load details: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const stillOpen = (parent.childSessionIds || [])
    .map((id) => sessions.get(id))
    .filter(
      (c) =>
        c &&
        (c.childStatus === "done" || c.childStatus === "conflict") &&
        !items.some((i) => i.childSessionId === c.id),
    );
  if (stillOpen.length) {
    lines.push("");
    lines.push("## Other children still awaiting merge");
    for (const c of stillOpen) {
      lines.push(`- \`${c!.id}\` ${c!.title} (${c!.childStatus})`);
    }
  }

  return lines.join("\n");
}

async function flushParentWake(parentSessionId: string): Promise<void> {
  if (parentWakeInFlight.has(parentSessionId)) return;

  const parent = sessions.get(parentSessionId);
  if (!parent) {
    parentWakeQueue.delete(parentSessionId);
    return;
  }

  const queued = parentWakeQueue.get(parentSessionId);
  if (!queued?.length) return;

  // Wait until the whole parallel batch is idle, so one wake covers everyone.
  if (parentHasRunningChildren(parent)) return;

  if (parent.busy) return; // retry from send queue pump / sendMessage finally

  const items = [...queued];
  parentWakeQueue.set(parentSessionId, []);
  parentWakeInFlight.add(parentSessionId);
  try {
    const prompt = await buildParentWakePrompt(parent, items);
    enqueueSessionSend(parentSessionId, prompt, {
      modelId: parent.model,
      mode: parent.mode === "plan" ? "plan" : "agent",
    }, "wake");
  } catch (err) {
    console.error("[subagents] parent auto-wake failed:", err);
    // Put back so a later idle flush can retry.
    const again = parentWakeQueue.get(parentSessionId) ?? [];
    parentWakeQueue.set(parentSessionId, [...items, ...again]);
  } finally {
    parentWakeInFlight.delete(parentSessionId);
    const left = parentWakeQueue.get(parentSessionId);
    const fresh = sessions.get(parentSessionId);
    if (
      left?.length &&
      fresh &&
      !fresh.busy &&
      !parentHasRunningChildren(fresh) &&
      !(sessionSendQueues.get(parentSessionId)?.length)
    ) {
      void flushParentWake(parentSessionId);
    }
  }
}

export type StreamEvent =
  | { type: "assistant_delta"; sessionId: string; text: string }
  | { type: "assistant_clear"; sessionId: string }
  | {
      type: "assistant_commit";
      sessionId: string;
      text: string;
      id: string;
      /** e.g. createPlan — UI can badge the message as a plan card. */
      toolName?: string;
      /** Wall-clock ms from busy start to this commit. */
      durationMs?: number;
    }
  | {
      type: "user_message";
      sessionId: string;
      message: ChatMessage;
      /** True when the run will start after the current one finishes. */
      queued?: boolean;
    }
  | {
      type: "activity";
      sessionId: string;
      id: string;
      kind: ActivityKind;
      label: string;
      status: "running" | "completed" | "error";
      durationMs?: number;
      detail?: string;
      usage?: TokenUsage;
      toolName?: string;
      filePath?: string;
      linesAdded?: number;
      linesRemoved?: number;
      linesCreated?: number;
    }
  | { type: "status"; sessionId: string; status: string; message?: string }
  | {
      type: "session_mode";
      sessionId: string;
      mode: "agent" | "plan";
    }
  | {
      type: "done";
      sessionId: string;
      runId: string;
      status: string;
      title?: string;
      usage?: TokenUsage;
      context?: ContextSnapshot;
    }
  | {
      type: "child_agent";
      sessionId: string;
      childSessionId: string;
      status: ChildAgentStatus;
      title?: string;
      branch?: string;
      message?: string;
    }
  | { type: "error"; sessionId: string; message: string }
  | {
      type: "rolled_back";
      sessionId: string;
      messageId: string;
      messages: ChatMessage[];
      hasMoreOlder?: boolean;
      messageCount?: number;
      filesRestored: boolean;
      restoredPrompt?: string;
    }
  | {
      type: "usage";
      sessionId: string;
      usage: TokenUsage;
      context?: ContextSnapshot;
    }
  | {
      type: "media";
      sessionId: string;
      path: string;
      kind: "image" | "video" | "file";
      label?: string;
    }
  | {
      type: "deploy_scheduled";
      restartAt: number;
      forceAt: number;
      delayMinutes: number;
      message?: string;
    }
  | {
      type: "deploy_cancelled";
      message?: string;
    }
  | {
      type: "deploy_restarting";
      message?: string;
    }
  | {
      type: "ask_question";
      sessionId: string;
      callId: string;
      toolCallId: string;
      title?: string;
      questions: AskQuestionItem[];
      status: "pending" | "answered" | "skipped";
      answers?: AskQuestionAnswer[];
    }
  | {
      type: "board_updated";
      workspace: string;
      board: {
        version: 1;
        nextId: number;
        columns: { id: string; title: string; order: number }[];
        cards: {
          id: string;
          columnId: string;
          title: string;
          body: string;
          order: number;
          createdAt: number;
          updatedAt: number;
        }[];
      };
    };

export type SendImageInput = {
  mimeType: string;
  /** raw base64 without data: prefix */
  data: string;
};

type Broadcaster = (event: StreamEvent) => void;

const sessions = new Map<string, SessionRecord>();
let broadcast: Broadcaster = () => {};
let persistReady = Promise.resolve();

function sessionsFile(): string {
  return join(dataDir(), "sessions.json");
}

export function setBroadcaster(fn: Broadcaster): void {
  broadcast = fn;
}

function requireApiKey(): string {
  return requireAgentApiKey();
}

function defaultModel(): string {
  return process.env.DEFAULT_MODEL?.trim() || "auto";
}

/** Local runtime options shared by create / resume / ensure. */
function localRuntime(cwd: string) {
  return {
    cwd,
    settingSources: ["project", "user"] as Array<"project" | "user">,
  };
}

function toSummary(session: SessionRecord): SessionSummary {
  return {
    id: session.id,
    agentId: session.agentId,
    workspace: session.workspace,
    model: session.model,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    mode: session.mode || "agent",
    busy: Boolean(session.busy),
    parentSessionId: session.parentSessionId,
    projectWorkspace: session.projectWorkspace || session.workspace,
    agentBranch: session.agentBranch,
    worktreePath: session.worktreePath,
    agentBaseSha: session.agentBaseSha,
    childStatus: session.childStatus,
    childSessionIds: session.childSessionIds?.length
      ? [...session.childSessionIds]
      : undefined,
  };
}

function toPersisted(session: SessionRecord): PersistedSession {
  return {
    id: session.id,
    agentId: session.agentId,
    workspace: session.workspace,
    model: session.model,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
    mode: session.mode || "agent",
    parentSessionId: session.parentSessionId,
    projectWorkspace: session.projectWorkspace || session.workspace,
    agentBranch: session.agentBranch,
    worktreePath: session.worktreePath,
    agentBaseSha: session.agentBaseSha,
    childStatus: session.childStatus,
    childSessionIds: session.childSessionIds?.length
      ? [...session.childSessionIds]
      : undefined,
  };
}

async function writeSessions(): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const payload = {
    version: 1,
    sessions: [...sessions.values()].map(toPersisted),
  };
  await writeFile(sessionsFile(), JSON.stringify(payload, null, 2), "utf8");
}

function schedulePersist(): void {
  persistReady = persistReady
    .then(() => writeSessions())
    .catch((err) => {
      console.error("Failed to persist sessions:", err);
    });
}

export async function loadPersistedSessions(): Promise<number> {
  try {
    const raw = await readFile(sessionsFile(), "utf8");
    const parsed = JSON.parse(raw) as { sessions?: PersistedSession[] };
    const items = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    for (const item of items) {
      if (!item?.id || !item.agentId) continue;
      sessions.set(item.id, {
        id: item.id,
        agentId: item.agentId,
        workspace: item.workspace,
        model: item.model || defaultModel(),
        title: item.title || "Chat",
        createdAt: item.createdAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
        messageCount: item.messages?.length ?? 0,
        messages: sanitizeMessages(Array.isArray(item.messages) ? item.messages : []),
        mode: item.mode === "plan" ? "plan" : "agent",
        agent: null,
        parentSessionId: item.parentSessionId,
        projectWorkspace: item.projectWorkspace || item.workspace,
        agentBranch: item.agentBranch,
        worktreePath: item.worktreePath,
        agentBaseSha: item.agentBaseSha,
        childStatus: item.childStatus,
        childSessionIds: Array.isArray(item.childSessionIds)
          ? item.childSessionIds
          : undefined,
      });
    }
    return sessions.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    console.error("Failed to load sessions:", err);
    return 0;
  }
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "question" || !Array.isArray(message.questionItems)) {
      return message;
    }
    return {
      ...message,
      questionItems: message.questionItems.map((question) => ({
        ...question,
        id: question.id || "q",
        prompt: question.prompt || "",
        options: Array.isArray(question.options) ? question.options : [],
      })),
    };
  });
}

/** Clear busy if the run is terminal, or prepare phase exceeded grace (missed finally / crash). */
function healStuckBusy(session: SessionRecord): void {
  if (!session.busy) return;
  const run = session.activeRun;

  if (!run) {
    // Still in prepare (checkpoint / ensureAgent / agent.send) — not stuck.
    // Old bug: treating !run as terminal unlocked the composer + played the done chime.
    const started = session.busyStartedAt ?? 0;
    if (!started || Date.now() - started < BUSY_PREPARE_GRACE_MS) return;
  } else {
    const status = run.status;
    const terminal =
      status === "finished" || status === "error" || status === "cancelled";
    if (!terminal) return;
  }

  const status = run?.status;
  setSessionBusy(session, false);
  session.activeRun = null;
  endAskSession(session.id);
  cancelAskQuestionsForSession(session.id, "Recovered stuck session");
  broadcast({
    type: "done",
    sessionId: session.id,
    runId: run?.id ?? "",
    status: status === "error" ? "error" : status === "cancelled" ? "cancelled" : "finished",
    title: session.title,
  });
  notifyDeployIdleCheck();
}

export function listSessions(): SessionSummary[] {
  for (const session of sessions.values()) healStuckBusy(session);
  return [...sessions.values()]
    .map(toSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): SessionRecord | undefined {
  const session = sessions.get(id);
  if (session) healStuckBusy(session);
  return session;
}

const MESSAGE_PAGE_MAX = 500;

/** Slice chat history for paged HTTP responses (full array stays in memory). */
export function sliceMessagesPage(
  messages: ChatMessage[],
  opts?: { limit?: number; before?: string },
): { messages: ChatMessage[]; hasMoreOlder: boolean; messageCount: number } {
  const messageCount = messages.length;
  if (opts?.limit == null || opts.limit <= 0) {
    return { messages, hasMoreOlder: false, messageCount };
  }
  const limit = Math.min(Math.floor(opts.limit), MESSAGE_PAGE_MAX);
  let end = messages.length;
  if (opts.before) {
    const idx = messages.findIndex((m) => m.id === opts.before);
    if (idx <= 0) {
      return { messages: [], hasMoreOlder: false, messageCount };
    }
    end = idx;
  }
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    hasMoreOlder: start > 0,
    messageCount,
  };
}

function normalizeProjectKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function projectDisplayName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path || "Unknown";
}

export type ProjectListItem = {
  key: string;
  workspace: string;
  name: string;
  updatedAt: number;
  /** Top-level sessions only (newest first), limited. */
  sessions: SessionSummary[];
  /** Children keyed by parent session id for the returned parents. */
  children: SessionSummary[];
  totalSessions: number;
  hasMoreSessions: boolean;
};

export function listProjects(opts?: {
  limit?: number;
  beforeUpdatedAt?: number;
  sessionsLimit?: number;
}): { projects: ProjectListItem[]; hasMore: boolean } {
  const all = listSessions();
  const childrenByParent = new Map<string, SessionSummary[]>();
  for (const session of all) {
    if (!session.parentSessionId) continue;
    const list = childrenByParent.get(session.parentSessionId) ?? [];
    list.push(session);
    childrenByParent.set(session.parentSessionId, list);
  }
  for (const [, list] of childrenByParent) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const groupMap = new Map<
    string,
    { workspace: string; updatedAt: number; sessions: SessionSummary[] }
  >();
  for (const session of all) {
    if (session.parentSessionId) continue;
    const parentWs = session.projectWorkspace || session.workspace;
    const key = normalizeProjectKey(parentWs || "");
    const kids = childrenByParent.get(session.id) ?? [];
    const sessionUpdated = Math.max(
      session.updatedAt,
      ...kids.map((k) => k.updatedAt),
    );
    const existing = groupMap.get(key);
    if (existing) {
      existing.sessions.push(session);
      existing.updatedAt = Math.max(existing.updatedAt, sessionUpdated);
    } else {
      groupMap.set(key, {
        workspace: parentWs,
        updatedAt: sessionUpdated,
        sessions: [session],
      });
    }
  }

  let groups = [...groupMap.entries()]
    .map(([key, g]) => ({
      key,
      workspace: g.workspace,
      name: projectDisplayName(g.workspace),
      updatedAt: g.updatedAt,
      sessions: [...g.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (opts?.beforeUpdatedAt != null) {
    const before = opts.beforeUpdatedAt;
    groups = groups.filter((g) => g.updatedAt < before);
  }

  const projectLimit =
    opts?.limit != null && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 100) : 12;
  const sessionsLimit =
    opts?.sessionsLimit != null && opts.sessionsLimit > 0
      ? Math.min(Math.floor(opts.sessionsLimit), 100)
      : 8;

  const page = groups.slice(0, projectLimit);
  const hasMore = groups.length > projectLimit;

  const projects: ProjectListItem[] = page.map((g) => {
    const totalSessions = g.sessions.length;
    const sessions = g.sessions.slice(0, sessionsLimit);
    const children: SessionSummary[] = [];
    for (const parent of sessions) {
      const kids = childrenByParent.get(parent.id);
      if (kids?.length) children.push(...kids);
    }
    return {
      key: g.key,
      workspace: g.workspace,
      name: g.name,
      updatedAt: g.updatedAt,
      sessions,
      children,
      totalSessions,
      hasMoreSessions: totalSessions > sessions.length,
    };
  });

  return { projects, hasMore };
}

export function listProjectSessions(opts: {
  workspace: string;
  limit?: number;
  beforeUpdatedAt?: number;
}): {
  sessions: SessionSummary[];
  children: SessionSummary[];
  hasMore: boolean;
} {
  const key = normalizeProjectKey(opts.workspace || "");
  const all = listSessions();
  const childrenByParent = new Map<string, SessionSummary[]>();
  for (const session of all) {
    if (!session.parentSessionId) continue;
    const list = childrenByParent.get(session.parentSessionId) ?? [];
    list.push(session);
    childrenByParent.set(session.parentSessionId, list);
  }
  for (const [, list] of childrenByParent) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  let topLevel = all
    .filter((s) => {
      if (s.parentSessionId) return false;
      const ws = s.projectWorkspace || s.workspace;
      return normalizeProjectKey(ws || "") === key;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (opts.beforeUpdatedAt != null) {
    const before = opts.beforeUpdatedAt;
    topLevel = topLevel.filter((s) => s.updatedAt < before);
  }

  const limit =
    opts.limit != null && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 100) : 8;
  const sessions = topLevel.slice(0, limit);
  const hasMore = topLevel.length > sessions.length;
  const children: SessionSummary[] = [];
  for (const parent of sessions) {
    const kids = childrenByParent.get(parent.id);
    if (kids?.length) children.push(...kids);
  }
  return { sessions, children, hasMore };
}

export async function getSessionContext(
  id: string,
): Promise<{ usage: TokenUsage | null; context: ContextSnapshot | null }> {
  const session = sessions.get(id);
  if (!session) return { usage: null, context: null };

  let usage: TokenUsage | null = null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const u = session.messages[i]?.usage;
    if (u && typeof u.inputTokens === "number") {
      usage = u;
      break;
    }
  }

  const context = await buildContextSnapshot({
    usage: usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    workspace: session.workspace,
    mode: session.mode === "plan" ? "plan" : "agent",
    messages: session.messages,
  });

  return { usage, context };
}

/**
 * Cursor SDK caches a short-lived JWT / gRPC session in-process. After idle
 * (~15m–1h) the next send fails with AuthenticationError (non-retryable in SDK).
 * Detect that so we can dispose + Agent.resume instead of forcing a server restart.
 */
function isStaleAuthFailure(err: unknown): boolean {
  if (err == null) return false;
  const parts: string[] = [];
  if (typeof err === "string") parts.push(err);
  if (err instanceof Error) {
    parts.push(err.name, err.message);
  }
  if (typeof err === "object") {
    const record = err as Record<string, unknown>;
    for (const key of ["code", "message", "error", "reason"] as const) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
      else if (value instanceof Error) parts.push(value.name, value.message);
      else if (value && typeof value === "object" && "message" in value) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === "string") parts.push(nested);
      }
    }
  }
  const hay = parts.join(" ").toLowerCase();
  return (
    hay.includes("authenticationerror") ||
    hay.includes("authentication error") ||
    hay.includes("unauthenticated") ||
    hay.includes("not_logged_in") ||
    hay.includes("error_not_logged_in") ||
    hay.includes("try logging out") ||
    hay.includes("not logged in")
  );
}

const AUTH_RECOVERY_FAILED_MESSAGE =
  "Cursor agent session expired after idle, and automatic reconnect failed. Restart the server (start-prod.bat) or send the message again.";

async function disposeAgentHandle(session: SessionRecord): Promise<void> {
  if (!session.agent) return;
  try {
    await session.agent[Symbol.asyncDispose]();
  } catch {
    try {
      session.agent.close();
    } catch {
      /* ignore */
    }
  }
  session.agent = null;
}

async function ensureAgent(session: SessionRecord): Promise<SDKAgent> {
  if (session.agent) return session.agent;
  const apiKey = requireApiKey();
  const mcpServers = await loadMcpServers();
  const agent = await Agent.resume(session.agentId, {
    apiKey,
    model: { id: session.model || defaultModel() },
    mode: session.mode || "agent",
    local: localRuntime(session.workspace),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  });
  session.agent = agent;
  session.agentId = agent.agentId;
  return agent;
}

export async function createSession(input: {
  workspace: string;
  model?: string;
  title?: string;
  mode?: AgentModeOption;
  id?: string;
  parentSessionId?: string;
  agentBranch?: string;
  worktreePath?: string;
  agentBaseSha?: string;
  childStatus?: ChildAgentStatus;
}): Promise<SessionSummary> {
  const model = input.model?.trim() || defaultModel();
  const mode = input.mode === "plan" ? "plan" : "agent";
  const apiKey = requireApiKey();
  const mcpServers = await loadMcpServers();
  const agent = await Agent.create({
    apiKey,
    name: input.title?.trim() || "Web CLI",
    model: { id: model },
    mode,
    local: localRuntime(input.workspace),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  });

  const now = Date.now();
  const parent = input.parentSessionId
    ? sessions.get(input.parentSessionId)
    : undefined;
  const session: SessionRecord = {
    id: input.id?.trim() || randomUUID(),
    agentId: agent.agentId,
    workspace: input.workspace,
    model,
    mode,
    title: input.title?.trim() || "New chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    agent,
    messages: [],
    parentSessionId: input.parentSessionId,
    projectWorkspace: parent?.workspace || input.workspace,
    agentBranch: input.agentBranch,
    worktreePath: input.worktreePath,
    agentBaseSha: input.agentBaseSha,
    childStatus: input.childStatus,
  };
  sessions.set(session.id, session);

  if (input.parentSessionId && parent) {
    const kids = parent.childSessionIds ? [...parent.childSessionIds] : [];
    if (!kids.includes(session.id)) kids.push(session.id);
    parent.childSessionIds = kids;
    parent.updatedAt = Date.now();
  }

  schedulePersist();
  return toSummary(session);
}

export async function resumeSession(input: {
  agentId: string;
  workspace: string;
  model?: string;
  title?: string;
  mode?: AgentModeOption;
}): Promise<SessionSummary> {
  const model = input.model?.trim() || defaultModel();
  const mode = input.mode === "plan" ? "plan" : "agent";
  const apiKey = requireApiKey();
  const mcpServers = await loadMcpServers();
  const agent = await Agent.resume(input.agentId, {
    apiKey,
    model: { id: model },
    mode,
    local: localRuntime(input.workspace),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  });

  const now = Date.now();
  const session: SessionRecord = {
    id: randomUUID(),
    agentId: agent.agentId,
    workspace: input.workspace,
    model,
    mode,
    title: input.title?.trim() || `Resume ${input.agentId.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    agent,
    messages: [],
  };
  sessions.set(session.id, session);
  schedulePersist();
  return toSummary(session);
}

export async function deleteSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;

  // Children first (while parent still exists for worktree cleanup).
  const children = [...(session.childSessionIds || [])];
  for (const childId of children) {
    await deleteSession(childId);
  }

  if (session.agent) {
    try {
      await session.agent[Symbol.asyncDispose]();
    } catch {
      session.agent.close();
    }
  }

  if (session.parentSessionId && session.worktreePath) {
    const parent = sessions.get(session.parentSessionId);
    if (parent) {
      try {
        const { removeChildWorktree } = await import("./git-worktree.js");
        await removeChildWorktree({
          parentWorkspace: parent.workspace,
          worktreePath: session.worktreePath,
          branch: session.agentBranch,
          deleteBranch: session.childStatus !== "merged",
        });
      } catch (err) {
        console.warn("Failed to remove child worktree:", err);
      }
      parent.childSessionIds = (parent.childSessionIds || []).filter((cid) => cid !== id);
      parent.updatedAt = Date.now();
    }
  }

  sessions.delete(id);
  schedulePersist();
  return true;
}

function busyElapsedMs(session: SessionRecord, at = Date.now()): number | undefined {
  const started = session.busyStartedAt;
  if (typeof started !== "number" || started <= 0) return undefined;
  const paused = askWaitPausedMs(session.id, at);
  return Math.max(0, at - started - paused);
}

function appendMessage(
  session: SessionRecord,
  role: ChatMessage["role"],
  content: string,
  extra?: Partial<
    Pick<
      ChatMessage,
      "toolName" | "checkpointSha" | "images" | "usage" | "context" | "mode" | "durationMs"
    >
  >,
): ChatMessage {
  const createdAt = Date.now();
  const message: ChatMessage = {
    id: randomUUID(),
    role,
    content,
    toolName: extra?.toolName,
    checkpointSha: extra?.checkpointSha,
    images: extra?.images,
    usage: extra?.usage,
    context: extra?.context,
    mode: extra?.mode,
    createdAt,
  };
  if (typeof extra?.durationMs === "number" && extra.durationMs >= 0) {
    message.durationMs = extra.durationMs;
  } else if (role === "assistant") {
    const elapsed = busyElapsedMs(session, createdAt);
    if (elapsed != null) message.durationMs = elapsed;
  }
  session.messages.push(message);
  session.updatedAt = Date.now();
  session.messageCount = session.messages.length;
  if (role === "user" && session.title === "New chat") {
    session.title = content.slice(0, 48) || session.title;
  }
  schedulePersist();
  if (role === "user") {
    broadcast({
      type: "user_message",
      sessionId: session.id,
      message,
    });
  }
  return message;
}

async function recreateAgent(session: SessionRecord): Promise<void> {
  if (session.agent) {
    try {
      await session.agent[Symbol.asyncDispose]();
    } catch {
      try {
        session.agent.close();
      } catch {
        /* ignore */
      }
    }
    session.agent = null;
  }

  const apiKey = requireApiKey();
  const mcpServers = await loadMcpServers();
  const agent = await Agent.create({
    apiKey,
    name: session.title || "Web CLI",
    model: { id: session.model || defaultModel() },
    mode: session.mode || "agent",
    local: localRuntime(session.workspace),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  });
  session.agent = agent;
  session.agentId = agent.agentId;
  schedulePersist();
}

/**
 * Restore chat to before the selected user turn (and files if a checkpoint exists).
 * Removes that user message and everything after; returns its text for the composer.
 */
export async function rollbackToMessage(
  sessionId: string,
  messageId: string,
): Promise<{
  messages: ChatMessage[];
  filesRestored: boolean;
  filesError?: string;
  restoredPrompt: string;
}> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.busy) throw new Error("Cannot rollback while the agent is running");

  const idx = session.messages.findIndex((message) => message.id === messageId);
  if (idx < 0) throw new Error("Message not found");

  let targetIdx = idx;
  let target = session.messages[targetIdx];

  // If an assistant/activity row was selected, roll back to the preceding user turn.
  if (target.role !== "user") {
    for (let i = idx; i >= 0; i -= 1) {
      const candidate = session.messages[i];
      if (candidate.role === "user") {
        targetIdx = i;
        target = candidate;
        break;
      }
    }
  }

  if (target.role !== "user") {
    throw new Error("Rollback target must be a user message");
  }

  const restoredPrompt = target.content;

  let filesRestored = false;
  let filesError: string | undefined;
  if (target.checkpointSha) {
    try {
      await restoreCheckpoint(session.workspace, target.checkpointSha);
      filesRestored = true;
    } catch (err) {
      filesError = err instanceof Error ? err.message : String(err);
      console.error("Rollback file restore failed:", filesError);
    }
  }

  // Drop the restored user message and everything after it.
  session.messages = session.messages.slice(0, targetIdx);
  session.messageCount = session.messages.length;
  session.updatedAt = Date.now();
  try {
    await recreateAgent(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Chat rolled back, but failed to reset agent: ${message}`);
  }
  schedulePersist();

  const rolledPage = sliceMessagesPage(session.messages, { limit: 30 });
  broadcast({
    type: "rolled_back",
    sessionId,
    messageId: target.id,
    messages: rolledPage.messages,
    hasMoreOlder: rolledPage.hasMoreOlder,
    messageCount: rolledPage.messageCount,
    filesRestored,
    restoredPrompt,
  });

  return {
    messages: session.messages,
    filesRestored,
    filesError,
    restoredPrompt,
  };
}

function persistActivity(
  session: SessionRecord,
  activity: {
    id: string;
    kind: ChatMessage["activityKind"];
    label: string;
    status: "completed" | "error";
    durationMs?: number;
    detail?: string;
    usage?: TokenUsage;
    toolName?: string;
    filePath?: string;
    linesAdded?: number;
    linesRemoved?: number;
    linesCreated?: number;
  },
): void {
  const existing = session.messages.find(
    (message) => message.role === "activity" && message.activityId === activity.id,
  );
  if (existing) {
    existing.content = activity.label;
    existing.activityKind = activity.kind;
    existing.activityStatus = activity.status;
    existing.durationMs = activity.durationMs ?? existing.durationMs;
    existing.detail = activity.detail ?? existing.detail;
    existing.usage = activity.usage ?? existing.usage;
    existing.toolName = activity.toolName ?? existing.toolName;
    existing.filePath = activity.filePath ?? existing.filePath;
    existing.linesAdded = activity.linesAdded ?? existing.linesAdded;
    existing.linesRemoved = activity.linesRemoved ?? existing.linesRemoved;
    existing.linesCreated = activity.linesCreated ?? existing.linesCreated;
    existing.createdAt = Date.now();
  } else {
    session.messages.push({
      id: randomUUID(),
      role: "activity",
      content: activity.label,
      activityId: activity.id,
      activityKind: activity.kind,
      activityStatus: activity.status,
      durationMs: activity.durationMs,
      detail: activity.detail,
      usage: activity.usage,
      toolName: activity.toolName,
      filePath: activity.filePath,
      linesAdded: activity.linesAdded,
      linesRemoved: activity.linesRemoved,
      linesCreated: activity.linesCreated,
      createdAt: Date.now(),
    });
  }
  session.updatedAt = Date.now();
  session.messageCount = session.messages.length;
  schedulePersist();
}

/** sessionId → activityId → wall-clock start (for duration when SDK omits it). */
const activityStartedAt = new Map<string, Map<string, number>>();

function rememberActivityStart(sessionId: string, activityId: string): void {
  let map = activityStartedAt.get(sessionId);
  if (!map) {
    map = new Map();
    activityStartedAt.set(sessionId, map);
  }
  if (!map.has(activityId)) map.set(activityId, Date.now());
}

function resolveActivityDurationMs(
  sessionId: string,
  activityId: string,
  provided?: number,
): number | undefined {
  if (typeof provided === "number" && provided >= 0 && Number.isFinite(provided)) {
    activityStartedAt.get(sessionId)?.delete(activityId);
    return provided;
  }
  const start = activityStartedAt.get(sessionId)?.get(activityId);
  activityStartedAt.get(sessionId)?.delete(activityId);
  if (typeof start !== "number" || start <= 0) return undefined;
  return Math.max(0, Date.now() - start);
}

function clearActivityStarts(sessionId: string): void {
  activityStartedAt.delete(sessionId);
}

function emitActivity(
  session: SessionRecord,
  activity: Extract<StreamEvent, { type: "activity" }>,
): void {
  // Fill duration before broadcast so the client can persist the same value.
  let durationMs = activity.durationMs;
  if (activity.id !== "working" && activity.id !== "planning") {
    if (activity.status === "running") {
      rememberActivityStart(session.id, activity.id);
    } else if (activity.status === "completed" || activity.status === "error") {
      durationMs = resolveActivityDurationMs(
        session.id,
        activity.id,
        activity.durationMs,
      );
    }
  }

  const event: Extract<StreamEvent, { type: "activity" }> = {
    ...activity,
    ...(typeof durationMs === "number" ? { durationMs } : {}),
  };
  broadcast(event);

  // Transient bootstrap indicator — don't keep "Working" in history.
  if (activity.id === "working" || activity.id === "planning") return;
  if (event.status === "completed" || event.status === "error") {
    persistActivity(session, {
      id: event.id,
      kind: event.kind,
      label: event.label,
      status: event.status,
      durationMs: event.durationMs,
      detail: event.detail,
      usage: event.usage,
      toolName: event.toolName,
      filePath: event.filePath,
      linesAdded: event.linesAdded,
      linesRemoved: event.linesRemoved,
      linesCreated: event.linesCreated,
    });
  }
}

function toolLabel(type: string): string {
  const labels: Record<string, string> = {
    read: "Reading",
    write: "Writing",
    edit: "Editing",
    delete: "Deleting",
    shell: "Shell",
    grep: "Grepping",
    glob: "Glob",
    ls: "Listing",
    semSearch: "Searching",
    readLints: "Checking lints",
    createPlan: "Planning",
    switchMode: "Switching mode",
    updateTodos: "Updating todos",
    task: "Task",
    mcp: "MCP",
    generateImage: "Generating image",
    recordScreen: "Recording",
  };
  return labels[type] || type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shortPath(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts.length <= 2) return norm;
  return parts.slice(-2).join("/");
}

function truncateOneLine(text: string, max = 72): string {
  const line = text.trim().replace(/\s+/g, " ");
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function normalizeToolType(type: string): string {
  return type.replace(/[_-]/g, "").toLowerCase();
}

function parseSwitchModeTarget(args: unknown): AgentModeOption | null {
  if (!isRecord(args)) return null;
  const raw =
    (typeof args.target_mode_id === "string" && args.target_mode_id) ||
    (typeof args.targetModeId === "string" && args.targetModeId) ||
    (typeof args.mode === "string" && args.mode) ||
    "";
  const id = raw.trim().toLowerCase();
  if (id === "plan") return "plan";
  if (id === "agent") return "agent";
  return null;
}

/** Apply agent SwitchMode tool to our session toggle + notify the web UI. */
function applySwitchModeRequest(
  session: SessionRecord,
  args: unknown,
): AgentModeOption | null {
  const next = parseSwitchModeTarget(args);
  if (!next) return null;
  if (session.mode !== next) {
    session.mode = next;
    session.updatedAt = Date.now();
    schedulePersist();
  }
  broadcast({
    type: "session_mode",
    sessionId: session.id,
    mode: next,
  });
  return next;
}

/** Unwrap CreatePlan args (SDK may nest under input/arguments). */
function createPlanFields(args: unknown): {
  name: string;
  overview: string;
  plan: string;
  todos: unknown[];
} {
  const root = isRecord(args) ? args : {};
  const nested =
    (isRecord(root.input) && root.input) ||
    (isRecord(root.arguments) && root.arguments) ||
    (isRecord(root.params) && root.params) ||
    null;
  const merged: Record<string, unknown> = nested ? { ...root, ...nested } : root;
  return {
    name: typeof merged.name === "string" ? merged.name.trim() : "",
    overview: typeof merged.overview === "string" ? merged.overview.trim() : "",
    plan: typeof merged.plan === "string" ? merged.plan.trim() : "",
    todos: Array.isArray(merged.todos) ? merged.todos : [],
  };
}

/** Build chat-visible markdown from CreatePlan tool args. */
function formatCreatePlanMarkdown(args: unknown): string | null {
  const { name, overview, plan, todos } = createPlanFields(args);
  if (!name && !overview && !plan) return null;

  const parts: string[] = [];
  // Prefer the plan body's own H1 when present — avoid "# Plan" + duplicate title.
  const planHasH1 = /^#\s+\S/m.test(plan);
  if (!planHasH1) {
    parts.push(name ? `# ${name}` : "# Plan");
    if (overview) parts.push("", overview);
  } else if (overview && !plan.includes(overview)) {
    parts.push(overview);
  }
  if (plan) {
    if (parts.length) parts.push("");
    parts.push(plan);
  }

  const todoLines: string[] = [];
  for (const item of todos) {
    if (!isRecord(item)) continue;
    const content =
      (typeof item.content === "string" && item.content.trim()) ||
      (typeof item.title === "string" && item.title.trim()) ||
      "";
    if (!content) continue;
    const status = typeof item.status === "string" ? item.status : "pending";
    const checked = status === "completed" || status === "cancelled";
    todoLines.push(`- [${checked ? "x" : " "}] ${content}`);
  }
  if (todoLines.length > 0) {
    parts.push("", "## Todos", "", ...todoLines);
  }
  return parts.join("\n").trim();
}

function isCreatePlanTool(type: string): boolean {
  return normalizeToolType(type) === "createplan";
}

function textLooksLikePlanDuplicate(text: string, planMarkdown: string): boolean {
  const a = text.trim().replace(/\s+/g, " ");
  const b = planMarkdown.trim().replace(/\s+/g, " ");
  if (a.length < 40 || b.length < 40) return false;
  const aHead = a.slice(0, 280);
  const bHead = b.slice(0, 280);
  return aHead.includes(bHead.slice(0, 120)) || bHead.includes(aHead.slice(0, 120));
}

/** Publish CreatePlan body as a normal assistant message in chat (not just a file link). */
function publishCreatePlanMessage(
  session: SessionRecord,
  args: unknown,
): ChatMessage | null {
  const markdown = formatCreatePlanMarkdown(args);
  if (!markdown) return null;
  const message = appendMessage(session, "assistant", markdown, {
    toolName: "createPlan",
    mode: "plan",
  });
  broadcast({
    type: "assistant_commit",
    sessionId: session.id,
    text: message.content,
    id: message.id,
    toolName: "createPlan",
    durationMs: message.durationMs,
  });
  return message;
}

/** Human-readable label + expandable detail from a tool call. */
function describeToolCall(
  type: string,
  args: unknown,
  result?: unknown,
): {
  label: string;
  detail: string;
  toolName: string;
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
  linesCreated?: number;
} {
  const base = toolLabel(type);
  const a = isRecord(args) ? args : {};
  const lines: string[] = [];

  const path =
    (typeof a.path === "string" && a.path) ||
    (typeof a.filePath === "string" && a.filePath) ||
    (typeof a.targetDirectory === "string" && a.targetDirectory) ||
    "";
  const command =
    (typeof a.command === "string" && a.command) ||
    (typeof a.cmd === "string" && a.cmd) ||
    "";
  const pattern =
    (typeof a.pattern === "string" && a.pattern) ||
    (typeof a.query === "string" && a.query) ||
    (typeof a.globPattern === "string" && a.globPattern) ||
    "";

  let label = base;

  // CreatePlan: short activity row; full body is committed as an assistant message.
  if (isCreatePlanTool(type)) {
    const { name, overview } = createPlanFields(a);
    if (name) label = `${base} · ${truncateOneLine(name, 48)}`;
    if (overview) lines.push(overview);
    else if (name) lines.push(name);
    return {
      label,
      detail: lines.join("\n").trim() || "createPlan",
      toolName: "createPlan",
    };
  }

  if (normalizeToolType(type) === "switchmode") {
    const target = parseSwitchModeTarget(a);
    const explanation =
      (typeof a.explanation === "string" && a.explanation.trim()) || "";
    if (target) label = `${base} · ${target}`;
    if (explanation) lines.push(explanation);
    else if (target) lines.push(`Switch to ${target}`);
    return {
      label,
      detail: lines.join("\n").trim() || type,
      toolName: type,
    };
  }

  if (type === "shell" && command) {
    label = `Shell · ${truncateOneLine(command, 56)}`;
    lines.push(command);
    if (typeof a.workingDirectory === "string" && a.workingDirectory) {
      lines.push(`cwd: ${a.workingDirectory}`);
    }
  } else if (path) {
    label = `${base} · ${shortPath(path)}`;
    lines.push(path);
    if (pattern) lines.push(`pattern: ${pattern}`);
  } else if (pattern) {
    label = `${base} · ${truncateOneLine(pattern, 40)}`;
    lines.push(pattern);
  }

  let linesAdded: number | undefined;
  let linesRemoved: number | undefined;
  let linesCreated: number | undefined;

  if (isRecord(result) && result.status === "success" && isRecord(result.value)) {
    const v = result.value;
    if (typeof v.linesAdded === "number" && Number.isFinite(v.linesAdded)) {
      linesAdded = Math.max(0, Math.round(v.linesAdded));
    }
    if (typeof v.linesRemoved === "number" && Number.isFinite(v.linesRemoved)) {
      linesRemoved = Math.max(0, Math.round(v.linesRemoved));
    }
    if (typeof v.linesCreated === "number" && Number.isFinite(v.linesCreated)) {
      linesCreated = Math.max(0, Math.round(v.linesCreated));
    }
    if (typeof v.diffString === "string" && v.diffString.trim()) {
      lines.push("--- diff ---", v.diffString.trim().slice(0, 8000));
    }
    if (typeof v.stdout === "string" && v.stdout.trim()) {
      lines.push("--- stdout ---", truncateOneLine(v.stdout, 2000));
    }
    if (typeof v.stderr === "string" && v.stderr.trim()) {
      lines.push("--- stderr ---", truncateOneLine(v.stderr, 1000));
    }
    if (typeof v.exitCode === "number") {
      lines.push(`exit: ${v.exitCode}`);
    }
  } else if (isRecord(result) && result.status === "error") {
    const err = result.error;
    lines.push(
      typeof err === "string"
        ? err
        : err != null
          ? JSON.stringify(err).slice(0, 500)
          : "error",
    );
  }

  if (lines.length === 0) {
    try {
      const raw = JSON.stringify(a);
      if (raw && raw !== "{}") lines.push(truncateOneLine(raw, 400));
    } catch {
      /* ignore */
    }
  }

  return {
    label,
    detail: lines.join("\n").trim() || type,
    toolName: type,
    filePath: path || undefined,
    linesAdded,
    linesRemoved,
    linesCreated,
  };
}

/** Persist generateImage / recordScreen output into session media store and notify UI. */
async function ingestToolMedia(
  session: SessionRecord,
  toolCall: unknown,
): Promise<string | null> {
  if (!isRecord(toolCall)) return null;
  const type = typeof toolCall.type === "string" ? toolCall.type : "";
  const args = isRecord(toolCall.args) ? toolCall.args : {};
  const result = isRecord(toolCall.result) ? toolCall.result : null;
  if (!result || result.status !== "success") return null;

  const value = isRecord(result.value) ? result.value : {};

  try {
    if (type === "generateImage") {
      const sourcePath =
        typeof value.filePath === "string" ? value.filePath : undefined;
      const imageData =
        typeof value.imageData === "string" ? value.imageData : undefined;
      const preferredName =
        typeof args.filePath === "string" ? args.filePath : undefined;
      const rel = await ingestSessionMedia(session.id, {
        sourcePath,
        imageData,
        preferredName,
        fallbackExt: ".png",
      });
      const label =
        typeof args.description === "string" && args.description.trim()
          ? args.description.trim().slice(0, 80)
          : "Generated image";
      broadcast({
        type: "media",
        sessionId: session.id,
        path: rel,
        kind: "image",
        label,
      });
      const message = appendMessage(session, "assistant", `![${label}](${rel})`);
      broadcast({
        type: "assistant_commit",
        sessionId: session.id,
        text: message.content,
        id: message.id,
        durationMs: message.durationMs,
      });
      return rel;
    }

    if (type === "recordScreen") {
      const sourcePath = typeof value.path === "string" ? value.path : undefined;
      if (!sourcePath || !isMediaPath(sourcePath)) return null;
      const rel = await ingestSessionMedia(session.id, {
        sourcePath,
        preferredName: basenameSafe(sourcePath),
        fallbackExt: extname(sourcePath) || ".webm",
      });
      broadcast({
        type: "media",
        sessionId: session.id,
        path: rel,
        kind: "video",
        label: "Recording",
      });
      const message = appendMessage(session, "assistant", `![Recording](${rel})`);
      broadcast({
        type: "assistant_commit",
        sessionId: session.id,
        text: message.content,
        id: message.id,
        durationMs: message.durationMs,
      });
      return rel;
    }
  } catch (err) {
    console.error("Failed to ingest tool media:", err);
  }
  return null;
}

function basenameSafe(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "media.bin";
}

function extname(filePath: string): string {
  const base = basenameSafe(filePath);
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i) : "";
}

function textFromAssistantEvent(event: Extract<SDKMessage, { type: "assistant" }>): string {
  return event.message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function sendMessage(
  sessionId: string,
  text: string,
  options?: {
    modelId?: string;
    mode?: AgentModeOption;
    images?: SendImageInput[];
  },
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");

  const queuedAhead = sessionSendQueues.get(sessionId)?.length ?? 0;
  if (session.busy || sessionSendPumping.has(sessionId) || queuedAhead > 0) {
    return new Promise((resolve, reject) => {
      pushSessionSend(sessionId, {
        text,
        options,
        source: "system",
        resolve,
        reject,
      });
      void pumpSessionSendQueue(sessionId);
    });
  }

  return sendMessageNow(sessionId, text, options);
}

/**
 * Queue a message for the session. User source jumps ahead of pending wake items.
 * Starts the run immediately when the session is idle.
 */
export function enqueueSessionSend(
  sessionId: string,
  text: string,
  options: {
    modelId?: string;
    mode?: AgentModeOption;
    images?: SendImageInput[];
  } | undefined,
  source: SessionSendSource,
): { queued: boolean } {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");

  const prompt = text.trim();
  const images = options?.images?.filter((img) => img.data && img.mimeType) ?? [];
  if (!prompt && images.length === 0) {
    throw new Error("Message text is required");
  }

  const wasBusy =
    session.busy ||
    sessionSendPumping.has(sessionId) ||
    (sessionSendQueues.get(sessionId)?.length ?? 0) > 0;

  pushSessionSend(sessionId, { text, options, source });
  void pumpSessionSendQueue(sessionId);
  return { queued: wasBusy };
}

function pushSessionSend(sessionId: string, item: SessionSendRequest): void {
  const q = sessionSendQueues.get(sessionId) ?? [];
  if (item.source === "user") {
    const wakeIdx = q.findIndex((x) => x.source === "wake");
    if (wakeIdx >= 0) q.splice(wakeIdx, 0, item);
    else q.push(item);
  } else {
    q.push(item);
  }
  sessionSendQueues.set(sessionId, q);
}

async function pumpSessionSendQueue(sessionId: string): Promise<void> {
  if (sessionSendPumping.has(sessionId)) return;
  const session = sessions.get(sessionId);
  if (!session) {
    sessionSendQueues.delete(sessionId);
    return;
  }
  if (session.busy) return;

  const q = sessionSendQueues.get(sessionId);
  if (!q?.length) {
    void flushParentWake(sessionId);
    return;
  }

  const next = q.shift()!;
  if (q.length) sessionSendQueues.set(sessionId, q);
  else sessionSendQueues.delete(sessionId);

  sessionSendPumping.add(sessionId);
  try {
    await sendMessageNow(sessionId, next.text, next.options);
    next.resolve?.();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (next.reject) next.reject(error);
    else console.error("[send-queue] run failed:", error);
  } finally {
    sessionSendPumping.delete(sessionId);
    void pumpSessionSendQueue(sessionId);
  }
}

async function sendMessageNow(
  sessionId: string,
  text: string,
  options?: {
    modelId?: string;
    mode?: AgentModeOption;
    images?: SendImageInput[];
  },
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.busy) throw new Error("Session is already running");

  // Lock immediately — checkpoint / ensureAgent are slow and used to race dual sends.
  setSessionBusy(session, true);
  beginAskSession(sessionId);
  broadcast({ type: "status", sessionId, status: "RUNNING" });
  emitActivity(session, {
    type: "activity",
    sessionId,
    id: "working",
    kind: "thinking",
    label: "Thinking",
    status: "running",
  });

  const prompt = text.trim();
  const images = options?.images?.filter((img) => img.data && img.mimeType) ?? [];
  if (!prompt && images.length === 0) {
    setSessionBusy(session, false);
    endAskSession(sessionId);
    throw new Error("Message text is required");
  }

  const model = options?.modelId?.trim() || session.model || defaultModel();
  const mode = options?.mode === "plan" ? "plan" : session.mode || "agent";
  session.model = model;
  session.mode = mode;
  schedulePersist();

  const chatImages: ChatImage[] = images.map((img) => ({
    mimeType: img.mimeType,
    dataUrl: `data:${img.mimeType};base64,${img.data}`,
  }));

  try {
    const checkpointSha = (await createCheckpoint(session.workspace)) ?? undefined;
    appendMessage(session, "user", prompt || "(image)", {
      checkpointSha,
      images: chatImages.length ? chatImages : undefined,
      mode,
    });
  } catch (err) {
    setSessionBusy(session, false);
    endAskSession(sessionId);
    broadcast({ type: "done", sessionId, runId: "", status: "error", title: session.title });
    throw err;
  }

  try {
    await ensureAgent(session);
  } catch (err) {
    if (isStaleAuthFailure(err)) {
      try {
        console.warn(
          "[agent] stale Cursor auth on ensureAgent; disposing and resuming once",
        );
        await disposeAgentHandle(session);
        await ensureAgent(session);
      } catch (retryErr) {
        setSessionBusy(session, false);
        endAskSession(sessionId);
        broadcast({ type: "error", sessionId, message: AUTH_RECOVERY_FAILED_MESSAGE });
        broadcast({ type: "done", sessionId, runId: "", status: "error", title: session.title });
        throw retryErr;
      }
    } else {
      setSessionBusy(session, false);
      endAskSession(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ type: "error", sessionId, message });
      broadcast({ type: "done", sessionId, runId: "", status: "error", title: session.title });
      throw err;
    }
  }
  const mcpServers = await loadMcpServers();
  const askUserTool = createAskUserCustomTool(sessionId);
  // Sub-agents cannot nest further — only top-level orchestrators get these tools.
  const subagentTools = session.parentSessionId
    ? {}
    : createSubagentTools(sessionId);

  let assistantBuffer = "";
  let thinkingId: string | null = null;
  let thinkingBuffer = "";
  let thinkingSource: "delta" | "stream" | null = null;
  let thinkingSeq = 0;
  let lastCompletedThinkingId: string | null = null;
  let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUsage: TokenUsage | undefined;
  let lastContext: ContextSnapshot | undefined;
  const ingestedMediaCalls = new Set<string>();
  /** Last published CreatePlan markdown — used to drop duplicate assistant text. */
  let publishedPlanText: string | null = null;

  const clearThinkingFlush = () => {
    if (thinkingFlushTimer) {
      clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = null;
    }
  };

  const emitThinkingRunning = () => {
    if (!thinkingId) return;
    emitActivity(session, {
      type: "activity",
      sessionId,
      id: thinkingId,
      kind: "thinking",
      label: "Thinking",
      status: "running",
      detail: thinkingBuffer || undefined,
    });
  };

  const scheduleThinkingBroadcast = () => {
    if (thinkingFlushTimer) return;
    thinkingFlushTimer = setTimeout(() => {
      thinkingFlushTimer = null;
      emitThinkingRunning();
    }, 120);
  };

  const publishUsage = async (usage: TokenUsage, runId?: string) => {
    lastUsage = usage;
    try {
      lastContext = await buildContextSnapshot({
        usage,
        workspace: session.workspace,
        mode: session.mode === "plan" ? "plan" : "agent",
        messages: session.messages,
      });
    } catch (err) {
      console.warn("context snapshot failed:", err);
      lastContext = {
        usedTokens: promptTokensFromUsage(usage),
        maxTokens: CONTEXT_WINDOW_TOKENS,
        percent: 0,
        categories: [],
      };
      lastContext.percent =
        Math.round((lastContext.usedTokens / CONTEXT_WINDOW_TOKENS) * 1000) / 10;
    }
    broadcast({ type: "usage", sessionId, usage, context: lastContext });
    if (runId) {
      emitActivity(session, {
        type: "activity",
        sessionId,
        id: `usage-${runId}`,
        kind: "usage",
        label: formatUsageLabel(usage, lastContext),
        status: "completed",
        usage,
      });
    }
  };

  const flushAssistantPartial = () => {
    const text = assistantBuffer.trim();
    if (!text) return;
    if (publishedPlanText && textLooksLikePlanDuplicate(text, publishedPlanText)) {
      assistantBuffer = "";
      return;
    }
    const message = appendMessage(session, "assistant", assistantBuffer);
    broadcast({
      type: "assistant_commit",
      sessionId,
      text: assistantBuffer,
      id: message.id,
      durationMs: message.durationMs,
    });
    assistantBuffer = "";
  };

  const beginThinking = (source: "delta" | "stream") => {
    // Prefer a single channel per thinking phase (delta wins over stream replay).
    if (thinkingId && thinkingSource && thinkingSource !== source) {
      return false;
    }
    // Phase already closed — ignore late reopen (prevents empty duplicate Thought rows).
    if (!thinkingId && lastCompletedThinkingId) {
      return false;
    }
    if (!thinkingId) {
      thinkingSeq += 1;
      thinkingId = `thinking-${thinkingSeq}`;
      thinkingBuffer = "";
      thinkingSource = source;
      // Clear bootstrap indicator, then show a live Thinking row immediately.
      emitActivity(session, {
        type: "activity",
        sessionId,
        id: "working",
        kind: "thinking",
        label: "Thinking",
        status: "completed",
      });
      emitActivity(session, {
        type: "activity",
        sessionId,
        id: thinkingId,
        kind: "thinking",
        label: "Thinking",
        status: "running",
      });
    }
    return true;
  };

  const patchThinkingDuration = (durationMs: number) => {
    if (!lastCompletedThinkingId) return;
    emitActivity(session, {
      type: "activity",
      sessionId,
      id: lastCompletedThinkingId,
      kind: "thinking",
      label: "Thought",
      status: "completed",
      durationMs,
    });
  };

  const completeThinking = (durationMs?: number) => {
    if (!thinkingId) return;
    clearThinkingFlush();
    const id = thinkingId;
    emitActivity(session, {
      type: "activity",
      sessionId,
      id,
      kind: "thinking",
      label: "Thought",
      status: "completed",
      durationMs,
      detail: thinkingBuffer || undefined,
    });
    lastCompletedThinkingId = id;
    thinkingId = null;
    thinkingBuffer = "";
    // Keep thinkingSource so late stream/delta events know which channel owned this phase.
  };

  const startNewThinkingPhase = () => {
    lastCompletedThinkingId = null;
    thinkingSource = null;
  };

  const payload =
    images.length > 0
      ? {
          text: prompt || " ",
          images: images.map((img) => ({
            data: img.data,
            mimeType: img.mimeType,
          })),
        }
      : prompt;

  await runWithAskSession(sessionId, async () => {
  let authRetried = false;

  const resetTurnBuffers = () => {
    clearThinkingFlush();
    assistantBuffer = "";
    thinkingId = null;
    thinkingBuffer = "";
    thinkingSource = null;
    lastCompletedThinkingId = null;
    lastUsage = undefined;
    lastContext = undefined;
    ingestedMediaCalls.clear();
    publishedPlanText = null;
    session.activeRun = null;
  };

  const hadTurnProgress = () =>
    Boolean(assistantBuffer) || ingestedMediaCalls.size > 0;

  try {
  while (true) {
  let run: Run;
  try {
    const agent = await ensureAgent(session);
    run = await agent.send(payload, {
      model: { id: model },
      mode,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      local: {
        customTools: {
          ask_user: askUserTool,
          ...subagentTools,
        },
      },
      onDelta: async ({ update }) => {
        if (update.type === "text-delta") {
          if (thinkingId) completeThinking();
          else {
            emitActivity(session, {
              type: "activity",
              sessionId,
              id: "working",
              kind: "thinking",
              label: "Thinking",
              status: "completed",
            });
          }
          // After a plan card is published, ignore streamed restatements of it.
          if (publishedPlanText) {
            assistantBuffer += update.text;
            if (textLooksLikePlanDuplicate(assistantBuffer, publishedPlanText)) {
              return;
            }
            // Diverged into real follow-up prose — start streaming again from here.
            const follow = update.text;
            assistantBuffer = follow;
            broadcast({ type: "assistant_delta", sessionId, text: follow });
            publishedPlanText = null;
            return;
          }
          assistantBuffer += update.text;
          broadcast({ type: "assistant_delta", sessionId, text: update.text });
          return;
        }

        if (update.type === "thinking-delta") {
          // Late deltas after this phase already closed — don't open a duplicate Thought.
          if (!thinkingId && lastCompletedThinkingId) return;
          if (!thinkingId) startNewThinkingPhase();
          if (!beginThinking("delta")) return;
          thinkingBuffer = mergeThinkingText(thinkingBuffer, update.text || "");
          scheduleThinkingBroadcast();
          return;
        }

        if (update.type === "thinking-completed") {
          if (thinkingId) {
            completeThinking(update.thinkingDurationMs);
          } else if (update.thinkingDurationMs != null) {
            // Duration arrived after we already closed this Thought — patch, don't duplicate.
            patchThinkingDuration(update.thinkingDurationMs);
          }
          return;
        }

        if (update.type === "tool-call-started") {
          if (thinkingId) completeThinking();
          startNewThinkingPhase();
          if (isCreatePlanTool(update.toolCall.type)) {
            // Plan body comes from tool args as a tagged card — drop streamed prose.
            assistantBuffer = "";
            broadcast({ type: "assistant_clear", sessionId });
          } else {
            flushAssistantPartial();
          }
          const described = describeToolCall(
            update.toolCall.type,
            "args" in update.toolCall ? update.toolCall.args : undefined,
          );
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: update.callId,
            kind: "tool",
            label: described.label,
            status: "running",
            detail: described.detail,
            toolName: described.toolName,
            filePath: described.filePath,
          });
          return;
        }

        if (update.type === "tool-call-completed") {
          const toolArgs =
            "args" in update.toolCall ? update.toolCall.args : undefined;
          const described = describeToolCall(
            update.toolCall.type,
            toolArgs,
            "result" in update.toolCall ? update.toolCall.result : undefined,
          );
          let detail = described.detail;
          let label = described.label;
          if (
            !ingestedMediaCalls.has(update.callId) &&
            (update.toolCall.type === "generateImage" ||
              update.toolCall.type === "recordScreen")
          ) {
            ingestedMediaCalls.add(update.callId);
            const rel = await ingestToolMedia(session, update.toolCall);
            if (rel) {
              detail = rel;
              label = `${toolLabel(update.toolCall.type)} · ${rel}`;
            }
          }
          if (
            isCreatePlanTool(update.toolCall.type) &&
            !ingestedMediaCalls.has(update.callId)
          ) {
            ingestedMediaCalls.add(update.callId);
            const published = publishCreatePlanMessage(session, toolArgs);
            if (published) {
              publishedPlanText = published.content;
              assistantBuffer = "";
            }
          }
          if (normalizeToolType(update.toolCall.type) === "switchmode") {
            applySwitchModeRequest(session, toolArgs);
          }
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: update.callId,
            kind: "tool",
            label,
            status: "completed",
            detail,
            toolName: described.toolName,
            filePath: described.filePath,
            linesAdded: described.linesAdded,
            linesRemoved: described.linesRemoved,
            linesCreated: described.linesCreated,
          });
          return;
        }

        if (update.type === "step-started") {
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: `step-${update.stepId}`,
            kind: "step",
            label: `Step ${update.stepId}`,
            status: "running",
          });
          return;
        }

        if (update.type === "step-completed") {
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: `step-${update.stepId}`,
            kind: "step",
            label: `Step ${update.stepId}`,
            status: "completed",
            durationMs: update.stepDurationMs,
          });
          return;
        }

        if (update.type === "summary-started") {
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: "summary",
            kind: "summary",
            label: "Summarizing",
            status: "running",
          });
          return;
        }

        if (update.type === "summary-completed") {
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: "summary",
            kind: "summary",
            label: "Summarized",
            status: "completed",
          });
        }
      },
    });
  } catch (err) {
    if (!authRetried && isStaleAuthFailure(err)) {
      authRetried = true;
      console.warn(
        "[agent] stale Cursor auth on send; disposing agent and retrying once",
      );
      await disposeAgentHandle(session);
      resetTurnBuffers();
      broadcast({
        type: "status",
        sessionId,
        status: "RUNNING",
        message: "Reconnecting agent after idle…",
      });
      continue;
    }
    const message = isStaleAuthFailure(err)
      ? AUTH_RECOVERY_FAILED_MESSAGE
      : err instanceof Error
        ? err.message
        : String(err);
    // Stale SDK run lock — clear and surface cleanly.
    broadcast({ type: "error", sessionId, message });
    broadcast({
      type: "done",
      sessionId,
      runId: "",
      status: "error",
      title: session.title,
    });
    throw err;
  }

  session.activeRun = run;

  try {
    for await (const event of run.stream()) {
      switch (event.type) {
        case "assistant": {
          const chunk = textFromAssistantEvent(event);
          if (!chunk) break;
          if (chunk.startsWith(assistantBuffer)) {
            const delta = chunk.slice(assistantBuffer.length);
            if (delta) {
              assistantBuffer = chunk;
              broadcast({ type: "assistant_delta", sessionId, text: delta });
            }
          } else if (!assistantBuffer) {
            assistantBuffer = chunk;
            broadcast({ type: "assistant_delta", sessionId, text: chunk });
          }
          break;
        }
        case "thinking":
          if (event.text) {
            if (thinkingSource === "delta" && thinkingId) {
              // Deltas own the phase, but stream may carry cumulative text — merge if longer.
              const merged = mergeThinkingText(thinkingBuffer, event.text);
              if (merged !== thinkingBuffer) {
                thinkingBuffer = merged;
                scheduleThinkingBroadcast();
              }
            } else if (!thinkingId && lastCompletedThinkingId) {
              /* late stream replay after this phase closed — ignore text */
            } else {
              if (!thinkingId) startNewThinkingPhase();
              if (beginThinking("stream")) {
                thinkingBuffer = mergeThinkingText(thinkingBuffer, event.text);
                scheduleThinkingBroadcast();
              }
            }
          }
          if (event.thinking_duration_ms != null) {
            if (thinkingId) {
              completeThinking(event.thinking_duration_ms);
            } else {
              patchThinkingDuration(event.thinking_duration_ms);
            }
          }
          break;
        case "tool_call":
          if (event.status === "running") {
            if (thinkingId) completeThinking();
            startNewThinkingPhase();
            if (isCreatePlanTool(event.name)) {
              assistantBuffer = "";
              broadcast({ type: "assistant_clear", sessionId });
            } else {
              flushAssistantPartial();
            }
          }
          {
            const described = describeToolCall(
              event.name,
              event.args,
              event.result,
            );
            if (
              event.status === "completed" &&
              isCreatePlanTool(event.name) &&
              !ingestedMediaCalls.has(event.call_id)
            ) {
              ingestedMediaCalls.add(event.call_id);
              const published = publishCreatePlanMessage(session, event.args);
              if (published) {
                publishedPlanText = published.content;
                assistantBuffer = "";
              }
            }
            if (
              event.status === "completed" &&
              normalizeToolType(event.name) === "switchmode"
            ) {
              applySwitchModeRequest(session, event.args);
            }
            emitActivity(session, {
              type: "activity",
              sessionId,
              id: event.call_id,
              kind: "tool",
              label: described.label,
              status:
                event.status === "running"
                  ? "running"
                  : event.status === "error"
                    ? "error"
                    : "completed",
              detail: described.detail,
              toolName: described.toolName,
              filePath: described.filePath,
              linesAdded: described.linesAdded,
              linesRemoved: described.linesRemoved,
              linesCreated: described.linesCreated,
            });
          }
          break;
        case "task":
          emitActivity(session, {
            type: "activity",
            sessionId,
            id: `task-${event.run_id}`,
            kind: "task",
            label: event.text?.trim() || "Working",
            status: event.status === "completed" ? "completed" : "running",
          });
          break;
        case "usage":
          await publishUsage(event.usage, event.run_id);
          break;
        case "status":
          broadcast({
            type: "status",
            sessionId,
            status: event.status,
            message: event.message,
          });
          break;
        default:
          break;
      }
    }

    const result = await run.wait();
    // result.usage is cumulative across turns — do not use it for the context ring.
    // Prefer per-turn `usage` stream events already handled above.
    if (result.usage && !lastUsage) {
      await publishUsage(result.usage);
    }
    if (!assistantBuffer && result.result) {
      assistantBuffer = result.result;
      broadcast({ type: "assistant_delta", sessionId, text: result.result });
    }

    if (
      result.status === "error" &&
      !authRetried &&
      !hadTurnProgress() &&
      isStaleAuthFailure(result.error ?? "Run failed")
    ) {
      authRetried = true;
      console.warn(
        "[agent] stale Cursor auth on run.wait; disposing agent and retrying once",
      );
      await disposeAgentHandle(session);
      resetTurnBuffers();
      broadcast({
        type: "status",
        sessionId,
        status: "RUNNING",
        message: "Reconnecting agent after idle…",
      });
      continue;
    }

    if (assistantBuffer) {
      const message = appendMessage(session, "assistant", assistantBuffer, {
        usage: lastUsage,
        context: lastContext,
      });
      broadcast({
        type: "assistant_commit",
        sessionId,
        text: assistantBuffer,
        id: message.id,
        durationMs: message.durationMs,
      });
      assistantBuffer = "";
    }
    if (result.status === "error") {
      const raw = result.error?.message ?? "Run failed";
      const message = isStaleAuthFailure(result.error ?? raw)
        ? AUTH_RECOVERY_FAILED_MESSAGE
        : raw;
      broadcast({ type: "error", sessionId, message });
    }
    broadcast({
      type: "done",
      sessionId,
      runId: result.id,
      status: result.status,
      title: session.title,
      usage: lastUsage,
      context: lastContext,
    });
    if (session.parentSessionId) {
      markChildRunFinished(session, result.status);
    }
    void notifyAgentFinished({
      title: session.title,
      status: result.status,
      sessionId,
    });
    break;
  } catch (err) {
    if (!authRetried && !hadTurnProgress() && isStaleAuthFailure(err)) {
      authRetried = true;
      console.warn(
        "[agent] stale Cursor auth during run; disposing agent and retrying once",
      );
      await disposeAgentHandle(session);
      resetTurnBuffers();
      broadcast({
        type: "status",
        sessionId,
        status: "RUNNING",
        message: "Reconnecting agent after idle…",
      });
      continue;
    }
    const message = isStaleAuthFailure(err)
      ? AUTH_RECOVERY_FAILED_MESSAGE
      : err instanceof Error
        ? err.message
        : String(err);
    broadcast({ type: "error", sessionId, message });
    broadcast({
      type: "done",
      sessionId,
      runId: run.id,
      status: "error",
      title: session.title,
      usage: lastUsage,
      context: lastContext,
    });
    markChildRunFinished(session, "error");
    void notifyAgentFinished({
      title: session.title,
      status: "error",
      sessionId,
    });
    throw err;
  }
  } // while
  } finally {
    cancelAskQuestionsForSession(sessionId, "Run finished");
    setSessionBusy(session, false);
    session.activeRun = null;
    endAskSession(sessionId);
    clearActivityStarts(sessionId);
    notifyDeployIdleCheck();
    // Drain queued user/wake sends; if empty, flush parent auto-wake.
    void pumpSessionSendQueue(sessionId);
  }
  });
}

export function submitAskQuestionAnswer(
  sessionId: string,
  callId: string,
  result: AskQuestionHandlerResult,
): ChatMessage {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  const prompt = resolveAskQuestion(sessionId, callId, result);
  const summary =
    result.outcome === "answered"
      ? formatAskQuestionSummary(prompt.title, prompt.questions, result.answers)
      : `Skipped questions${result.reason ? `: ${result.reason}` : ""}`;
  const message: ChatMessage = {
    id: randomUUID(),
    role: "question",
    content: summary,
    createdAt: Date.now(),
    questionTitle: prompt.title,
    questionItems: prompt.questions,
    questionStatus: result.outcome === "answered" ? "answered" : "skipped",
    questionAnswers: result.outcome === "answered" ? result.answers : undefined,
    questionCallId: callId,
  };
  session.messages.push(message);
  session.updatedAt = Date.now();
  schedulePersist();
  return message;
}

function formatAskQuestionSummary(
  title: string | undefined,
  questions: AskQuestionItem[],
  answers: AskQuestionAnswer[],
): string {
  const lines: string[] = [];
  if (title?.trim()) lines.push(title.trim());
  for (const question of questions) {
    const answer = answers.find((item) => item.questionId === question.id);
    const labels =
      answer?.selectedOptionIds
        .map(
          (id) =>
            question.options.find((option) => option.id === id)?.label ?? id,
        )
        .filter(Boolean) ?? [];
    const free = answer?.freeformText?.trim();
    const value = [...labels, free].filter(Boolean).join(", ") || "(no answer)";
    lines.push(`${question.prompt} → ${value}`);
  }
  return lines.join("\n");
}

function formatUsageLabel(usage: TokenUsage, context?: ContextSnapshot): string {
  if (context) {
    const suffix = context.estimated ? " · est." : "";
    return `Context · ${context.percent}% · ${formatCompactTokens(context.usedTokens)} / ${formatCompactTokens(context.maxTokens)}${suffix}`;
  }
  const used = promptTokensFromUsage(usage);
  const percent = Math.round((used / CONTEXT_WINDOW_TOKENS) * 1000) / 10;
  return `Context · ${percent}% · ${formatCompactTokens(used)} / ${formatCompactTokens(CONTEXT_WINDOW_TOKENS)}`;
}

function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export async function cancelSessionRun(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  cancelAskQuestionsForSession(sessionId, "Cancelled by user");
  const run = session.activeRun;
  if (!run) throw new Error("No active run");
  if (run.supports("cancel")) {
    await run.cancel();
    return;
  }
  await Agent.cancelRun(run.id, {
    runtime: "local",
    cwd: session.workspace,
  });
}

export async function listCursorAgents(workspace?: string): Promise<SDKAgentInfo[]> {
  const cwd = workspace?.trim() || process.env.DEFAULT_WORKSPACE?.trim() || process.cwd();
  const result = await Agent.list({
    runtime: "local",
    cwd,
  });
  return result.items;
}

export async function getSessionConversation(sessionId: string): Promise<unknown> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");

  if (session.activeRun?.supports("conversation")) {
    return session.activeRun.conversation();
  }

  return Agent.messages.list(session.agentId, {
    runtime: "local",
    cwd: session.workspace,
  });
}

export async function updateSession(
  sessionId: string,
  patch: { mode?: AgentModeOption; title?: string },
): Promise<SessionSummary> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (patch.mode === "plan" || patch.mode === "agent") {
    session.mode = patch.mode;
  }
  if (typeof patch.title === "string") {
    const next = patch.title.trim();
    if (next) session.title = next.slice(0, 120);
  }
  session.updatedAt = Date.now();
  schedulePersist();
  return toSummary(session);
}

export async function updateSessionMode(
  sessionId: string,
  mode: AgentModeOption,
): Promise<SessionSummary> {
  return updateSession(sessionId, { mode });
}

export type DelegateChildResult = {
  childSessionId: string;
  title: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
  status: ChildAgentStatus;
  waited: boolean;
  summary?: string;
  /** Parent git prepare step that ran before the worktree was created. */
  prepare?: {
    checkpointCreated: boolean;
    filesCommitted: number;
    headSha: string;
    message: string;
  };
};

/** Spawn a sub-agent in an isolated git worktree + branch. */
export async function spawnDelegatedChild(
  parentSessionId: string,
  input: {
    title: string;
    prompt: string;
    model?: string;
    /** If true, block until the child run finishes. Default false (parallel). */
    wait?: boolean;
  },
): Promise<DelegateChildResult> {
  const parent = sessions.get(parentSessionId);
  if (!parent) throw new Error("Parent session not found");
  if (parent.parentSessionId) {
    throw new Error("Sub-agents cannot spawn further sub-agents (one level only for now)");
  }

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required");
  const title = input.title.trim() || "Sub-agent";

  const childId = randomUUID();
  const {
    prepareParentForDelegate,
    createChildWorktree,
    summarizeChildBranch,
  } = await import("./git-worktree.js");

  const prepared = await prepareParentForDelegate(parent.workspace);
  if (!prepared.ok) {
    throw new Error(prepared.error);
  }

  const wt = await createChildWorktree({
    parentWorkspace: parent.workspace,
    parentSessionId,
    childSessionId: childId,
  });

  const child = await createSession({
    id: childId,
    workspace: wt.worktreePath,
    model: input.model?.trim() || parent.model,
    title: `↳ ${title}`,
    mode: "agent",
    parentSessionId,
    agentBranch: wt.branch,
    worktreePath: wt.worktreePath,
    agentBaseSha: wt.baseSha,
    childStatus: "running",
  });

  broadcast({
    type: "child_agent",
    sessionId: parentSessionId,
    childSessionId: child.id,
    status: "running",
    title: child.title,
    branch: wt.branch,
  });

  const kickoff = [
    `You are a delegated sub-agent. Work ONLY in this worktree/branch.`,
    `Branch: ${wt.branch}`,
    `When finished, summarize what you changed (files + outcome).`,
    ``,
    `## Task`,
    prompt,
  ].join("\n");

  const wait = Boolean(input.wait);
  if (wait) {
    const childRec = sessions.get(child.id);
    if (childRec) childRec.skipParentWake = true;
    await sendMessage(child.id, kickoff, { modelId: child.model, mode: "agent" });
    const fresh = sessions.get(child.id);
    let summary: string | undefined;
    try {
      summary = await summarizeChildBranch({
        parentWorkspace: parent.workspace,
        branch: wt.branch,
        baseSha: wt.baseSha,
      });
    } catch {
      /* ignore */
    }
    const lastAssistant = [...(fresh?.messages || [])]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant?.content) {
      summary = `${lastAssistant.content.slice(0, 4000)}\n\n${summary || ""}`.trim();
    }
    return {
      childSessionId: child.id,
      title: child.title,
      branch: wt.branch,
      worktreePath: wt.worktreePath,
      baseSha: wt.baseSha,
      status: fresh?.childStatus || "done",
      waited: true,
      summary,
      prepare: {
        checkpointCreated: prepared.checkpointCreated,
        filesCommitted: prepared.filesCommitted,
        headSha: prepared.headSha,
        message: prepared.message,
      },
    };
  }

  void sendMessage(child.id, kickoff, { modelId: child.model, mode: "agent" }).catch(
    (err) => {
      console.error("Delegated child failed to start:", err);
      const s = sessions.get(child.id);
      if (s) markChildRunFinished(s, "error");
    },
  );

  return {
    childSessionId: child.id,
    title: child.title,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    baseSha: wt.baseSha,
    status: "running",
    waited: false,
    prepare: {
      checkpointCreated: prepared.checkpointCreated,
      filesCommitted: prepared.filesCommitted,
      headSha: prepared.headSha,
      message: prepared.message,
    },
  };
}

export type MergeChildAgentResult = {
  childSessionId: string;
  ok: boolean;
  conflict: boolean;
  message: string;
  status: ChildAgentStatus;
  branchSummary?: string;
};

/** Merge a finished child's branch into the parent workspace and drop the worktree. */
export async function mergeDelegatedChild(
  parentSessionId: string,
  childSessionId: string,
): Promise<MergeChildAgentResult> {
  const parent = sessions.get(parentSessionId);
  const child = sessions.get(childSessionId);
  if (!parent) throw new Error("Parent session not found");
  if (!child) throw new Error("Child session not found");
  if (child.parentSessionId !== parentSessionId) {
    throw new Error("Child does not belong to this parent");
  }
  if (child.busy) throw new Error("Child is still running");
  if (!child.agentBranch || !child.worktreePath || !child.agentBaseSha) {
    throw new Error("Child is missing worktree metadata");
  }
  if (child.childStatus === "merged") {
    return {
      childSessionId,
      ok: true,
      conflict: false,
      message: "Already merged",
      status: "merged",
    };
  }

  const { mergeChildIntoParent, summarizeChildBranch } = await import(
    "./git-worktree.js"
  );

  let branchSummary: string | undefined;
  try {
    branchSummary = await summarizeChildBranch({
      parentWorkspace: parent.workspace,
      branch: child.agentBranch,
      baseSha: child.agentBaseSha,
    });
  } catch {
    /* ignore */
  }

  const result = await mergeChildIntoParent({
    parentWorkspace: parent.workspace,
    branch: child.agentBranch,
    worktreePath: child.worktreePath,
  });

  if (result.conflict) {
    child.childStatus = "conflict";
    child.updatedAt = Date.now();
    schedulePersist();
    broadcast({
      type: "child_agent",
      sessionId: parentSessionId,
      childSessionId,
      status: "conflict",
      title: child.title,
      branch: child.agentBranch,
      message: result.message,
    });
    return {
      childSessionId,
      ok: false,
      conflict: true,
      message: `${result.message}\n\nResolve conflicts in the parent workspace, then retry merge_child or abort with git merge --abort.`,
      status: "conflict",
      branchSummary,
    };
  }

  if (!result.ok) {
    child.childStatus = "error";
    child.updatedAt = Date.now();
    schedulePersist();
    return {
      childSessionId,
      ok: false,
      conflict: false,
      message: result.message,
      status: "error",
      branchSummary,
    };
  }

  child.childStatus = "merged";
  child.worktreePath = undefined;
  child.updatedAt = Date.now();
  schedulePersist();
  broadcast({
    type: "child_agent",
    sessionId: parentSessionId,
    childSessionId,
    status: "merged",
    title: child.title,
    branch: child.agentBranch,
    message: result.message,
  });

  return {
    childSessionId,
    ok: true,
    conflict: false,
    message: result.message,
    status: "merged",
    branchSummary,
  };
}

export async function getDelegatedChildResult(
  parentSessionId: string,
  childSessionId: string,
): Promise<{
  childSessionId: string;
  title: string;
  status: ChildAgentStatus | "unknown";
  busy: boolean;
  branch?: string;
  branchSummary?: string;
  lastAssistant?: string;
}> {
  const parent = sessions.get(parentSessionId);
  const child = sessions.get(childSessionId);
  if (!parent) throw new Error("Parent session not found");
  if (!child || child.parentSessionId !== parentSessionId) {
    throw new Error("Child not found for this parent");
  }

  let branchSummary: string | undefined;
  if (child.agentBranch && child.agentBaseSha) {
    try {
      const { summarizeChildBranch } = await import("./git-worktree.js");
      branchSummary = await summarizeChildBranch({
        parentWorkspace: parent.workspace,
        branch: child.agentBranch,
        baseSha: child.agentBaseSha,
      });
    } catch {
      /* ignore */
    }
  }

  const lastAssistant = [...child.messages]
    .reverse()
    .find((m) => m.role === "assistant");

  return {
    childSessionId,
    title: child.title,
    status: child.childStatus || "unknown",
    busy: Boolean(child.busy),
    branch: child.agentBranch,
    branchSummary,
    lastAssistant: lastAssistant?.content?.slice(0, 6000),
  };
}

/** Close live agent handles without deleting persisted sessions. */
export async function disposeAllSessions(): Promise<void> {
  await persistReady;
  for (const session of sessions.values()) {
    if (!session.agent) continue;
    try {
      await session.agent[Symbol.asyncDispose]();
    } catch {
      try {
        session.agent.close();
      } catch {
        /* ignore */
      }
    }
    session.agent = null;
  }
}
