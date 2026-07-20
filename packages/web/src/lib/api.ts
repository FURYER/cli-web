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
  mode?: "agent" | "plan";
  busy?: boolean;
  parentSessionId?: string;
  projectWorkspace?: string;
  agentBranch?: string;
  worktreePath?: string;
  agentBaseSha?: string;
  childStatus?: ChildAgentStatus;
  childSessionIds?: string[];
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

export type ContextCategory = {
  id: string;
  label: string;
  tokens: number;
};

export type ContextSnapshot = {
  usedTokens: number;
  maxTokens: number;
  percent: number;
  categories: ContextCategory[];
  estimated?: boolean;
};

export type ChatImage = {
  mimeType: string;
  dataUrl: string;
};

export type AskQuestionOption = {
  id: string;
  label: string;
};

export type AskQuestionItem = {
  id: string;
  prompt: string;
  options: AskQuestionOption[];
  allowMultiple?: boolean;
};

export type AskQuestionAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  freeformText?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "activity" | "question";
  content: string;
  toolName?: string;
  createdAt: number;
  activityId?: string;
  activityKind?: "thinking" | "tool" | "step" | "summary" | "task" | "usage";
  activityStatus?: "running" | "completed" | "error";
  durationMs?: number;
  detail?: string;
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
  linesCreated?: number;
  checkpointSha?: string;
  /** Agent mode used for this user turn. */
  mode?: "agent" | "plan";
  images?: ChatImage[];
  usage?: TokenUsage;
  context?: ContextSnapshot;
  questionTitle?: string;
  questionItems?: AskQuestionItem[];
  questionStatus?: "answered" | "skipped";
  questionAnswers?: AskQuestionAnswer[];
  questionCallId?: string;
  /** Waiting behind the current agent run (optimistic / server send queue). */
  queued?: boolean;
};

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

export type StreamEvent =
  | { type: "assistant_delta"; sessionId: string; text: string }
  | { type: "assistant_clear"; sessionId: string }
  | {
      type: "assistant_commit";
      sessionId: string;
      text: string;
      id: string;
      toolName?: string;
      durationMs?: number;
    }
  | {
      type: "user_message";
      sessionId: string;
      message: ChatMessage;
      queued?: boolean;
    }
  | {
      type: "queue_cancelled";
      sessionId: string;
      clientMessageId: string;
    }
  | {
      type: "activity";
      sessionId: string;
      id: string;
      kind: "thinking" | "tool" | "step" | "summary" | "task" | "usage";
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
  | { type: "usage"; sessionId: string; usage: TokenUsage; context?: ContextSnapshot }
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
  | { type: "deploy_cancelled"; message?: string }
  | { type: "deploy_restarting"; message?: string }
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
      board: Board;
    }
  | { type: "ping"; t?: number }
  | { type: "pong"; t?: number };

export type ActivityItem = Extract<StreamEvent, { type: "activity" }>;

const TOKEN_KEY = "webcli.accessToken";
const TOKEN_KEY_LEGACY = "cursor-cli.accessToken";

export type AuthMode = {
  accessToken: string;
};

function authHeaders(auth: AuthMode, hasBody: boolean): HeadersInit {
  const headers: Record<string, string> = {};
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  if (auth.accessToken) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
  }
  return headers;
}

export function loadStoredToken(): string {
  try {
    return (
      localStorage.getItem(TOKEN_KEY) ||
      localStorage.getItem(TOKEN_KEY_LEGACY) ||
      ""
    );
  } catch {
    return "";
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY_LEGACY);
  } catch {
    /* ignore */
  }
}

export type DeployStatus = {
  scheduled: boolean;
  restartAt: number | null;
  forceAt: number | null;
  delayMinutes: number | null;
  busySessions: number;
  waitingForIdle: boolean;
  message: string | null;
};

export type HealthInfo = {
  ok: boolean;
  stand?: boolean;
  port?: number;
  deploy?: DeployStatus;
};

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as HealthInfo;
}

export function getDeployStatus(auth: AuthMode): Promise<DeployStatus> {
  return request("/api/admin/deploy", auth);
}

export function scheduleDeploy(
  auth: AuthMode,
  delayMinutes?: number,
): Promise<DeployStatus> {
  return request("/api/admin/deploy", auth, {
    method: "POST",
    body: JSON.stringify({ delayMinutes }),
  });
}

export function cancelDeploy(auth: AuthMode): Promise<DeployStatus> {
  return request("/api/admin/deploy/cancel", auth, {
    method: "POST",
    body: "{}",
  });
}

async function request<T>(
  path: string,
  auth: AuthMode,
  init?: RequestInit,
): Promise<T> {
  const hasBody = init?.body != null && init.body !== "";
  const res = await fetch(path, {
    ...init,
    headers: {
      ...authHeaders(auth, hasBody),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

export function listSessions(auth: AuthMode): Promise<SessionSummary[]> {
  return request("/api/sessions", auth);
}

export type ProjectListItem = {
  key: string;
  workspace: string;
  name: string;
  updatedAt: number;
  sessions: SessionSummary[];
  children: SessionSummary[];
  totalSessions: number;
  hasMoreSessions: boolean;
};

export function listProjects(
  auth: AuthMode,
  opts?: { limit?: number; beforeUpdatedAt?: number; sessionsLimit?: number },
): Promise<{ projects: ProjectListItem[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.beforeUpdatedAt != null) {
    params.set("beforeUpdatedAt", String(opts.beforeUpdatedAt));
  }
  if (opts?.sessionsLimit != null) {
    params.set("sessionsLimit", String(opts.sessionsLimit));
  }
  const qs = params.toString();
  return request(`/api/projects${qs ? `?${qs}` : ""}`, auth);
}

export function listProjectSessions(
  auth: AuthMode,
  opts: { workspace: string; limit?: number; beforeUpdatedAt?: number },
): Promise<{
  sessions: SessionSummary[];
  children: SessionSummary[];
  hasMore: boolean;
}> {
  const params = new URLSearchParams();
  params.set("workspace", opts.workspace);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.beforeUpdatedAt != null) {
    params.set("beforeUpdatedAt", String(opts.beforeUpdatedAt));
  }
  return request(`/api/projects/sessions?${params}`, auth);
}

export const MESSAGE_PAGE_SIZE = 30;

export function getSession(
  auth: AuthMode,
  id: string,
  opts?: { limit?: number; before?: string },
): Promise<
  SessionSummary & {
    messages: ChatMessage[];
    hasMoreOlder?: boolean;
    usage?: TokenUsage;
    context?: ContextSnapshot;
  }
> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", opts.before);
  const qs = params.toString();
  return request(`/api/sessions/${id}${qs ? `?${qs}` : ""}`, auth);
}

export function createSession(
  auth: AuthMode,
  input: { workspace: string; model?: string; title?: string; mode?: "agent" | "plan" },
): Promise<SessionSummary> {
  return request("/api/sessions", auth, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function resumeSession(
  auth: AuthMode,
  input: {
    agentId: string;
    workspace: string;
    model?: string;
    title?: string;
    mode?: "agent" | "plan";
  },
): Promise<SessionSummary> {
  return request(`/api/sessions/${encodeURIComponent(input.agentId)}/resume`, auth, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type SendImagePayload = { mimeType: string; data: string };

export function sendMessage(
  auth: AuthMode,
  sessionId: string,
  text: string,
  opts?: {
    model?: string;
    mode?: "agent" | "plan";
    images?: SendImagePayload[];
    clientMessageId?: string;
  },
): Promise<{ accepted: boolean; queued?: boolean }> {
  return request(`/api/sessions/${sessionId}/messages`, auth, {
    method: "POST",
    body: JSON.stringify({
      text,
      model: opts?.model,
      mode: opts?.mode,
      images: opts?.images,
      clientMessageId: opts?.clientMessageId,
    }),
  });
}

export function cancelQueuedMessage(
  auth: AuthMode,
  sessionId: string,
  match: { clientMessageId?: string; content?: string },
): Promise<{ ok: boolean; clientMessageId?: string }> {
  return request(`/api/sessions/${sessionId}/messages/queue`, auth, {
    method: "DELETE",
    body: JSON.stringify(match),
  });
}

export function cancelRun(auth: AuthMode, sessionId: string): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/cancel`, auth, { method: "POST" });
}

export function answerAskQuestion(
  auth: AuthMode,
  sessionId: string,
  callId: string,
  body:
    | { outcome: "answered"; answers: AskQuestionAnswer[] }
    | { outcome: "skipped"; reason?: string },
): Promise<{ ok: boolean; message: ChatMessage }> {
  return request(`/api/sessions/${sessionId}/ask-questions/${encodeURIComponent(callId)}/answer`, auth, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listPendingAskQuestions(
  auth: AuthMode,
  sessionId: string,
): Promise<{
  pending: Array<{
    callId: string;
    toolCallId: string;
    title?: string;
    questions: AskQuestionItem[];
  }>;
}> {
  return request(`/api/sessions/${sessionId}/ask-questions`, auth);
}

export function updateSessionMode(
  auth: AuthMode,
  sessionId: string,
  mode: "agent" | "plan",
): Promise<SessionSummary> {
  return updateSession(auth, sessionId, { mode });
}

export function updateSession(
  auth: AuthMode,
  sessionId: string,
  patch: { mode?: "agent" | "plan"; title?: string },
): Promise<SessionSummary> {
  return request(`/api/sessions/${sessionId}`, auth, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function getConversation(
  auth: AuthMode,
  sessionId: string,
): Promise<{ conversation: unknown }> {
  return request(`/api/sessions/${sessionId}/conversation`, auth);
}

export function listAgents(
  auth: AuthMode,
  workspace?: string,
): Promise<{
  items: {
    agentId: string;
    name: string;
    summary: string;
    lastModified: number;
    status?: string;
  }[];
}> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  return request(`/api/agents${qs}`, auth);
}

export function getMcp(auth: AuthMode): Promise<{ servers: Record<string, unknown> }> {
  return request("/api/mcp", auth);
}

function boardQs(workspace: string): string {
  return `?workspace=${encodeURIComponent(workspace)}`;
}

export function getBoard(auth: AuthMode, workspace: string): Promise<Board> {
  return request(`/api/board${boardQs(workspace)}`, auth);
}

export function putBoard(auth: AuthMode, workspace: string, board: Board): Promise<Board> {
  return request(`/api/board${boardQs(workspace)}`, auth, {
    method: "PUT",
    body: JSON.stringify(board),
  });
}

export function addBoardColumn(
  auth: AuthMode,
  workspace: string,
  title: string,
): Promise<Board> {
  return request(`/api/board/columns${boardQs(workspace)}`, auth, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function patchBoardColumn(
  auth: AuthMode,
  workspace: string,
  columnId: string,
  patch: { title?: string; order?: number },
): Promise<Board> {
  return request(
    `/api/board/columns/${encodeURIComponent(columnId)}${boardQs(workspace)}`,
    auth,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function deleteBoardColumn(
  auth: AuthMode,
  workspace: string,
  columnId: string,
): Promise<Board> {
  return request(
    `/api/board/columns/${encodeURIComponent(columnId)}${boardQs(workspace)}`,
    auth,
    { method: "DELETE" },
  );
}

export function addBoardCard(
  auth: AuthMode,
  workspace: string,
  input: { title: string; body?: string; columnId?: string },
): Promise<Board> {
  return request(`/api/board/cards${boardQs(workspace)}`, auth, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchBoardCard(
  auth: AuthMode,
  workspace: string,
  cardId: string,
  patch: { title?: string; body?: string; columnId?: string; order?: number },
): Promise<Board> {
  return request(
    `/api/board/cards/${encodeURIComponent(cardId)}${boardQs(workspace)}`,
    auth,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function moveBoardCard(
  auth: AuthMode,
  workspace: string,
  cardId: string,
  input: { columnId: string; order?: number },
): Promise<Board> {
  return request(
    `/api/board/cards/${encodeURIComponent(cardId)}/move${boardQs(workspace)}`,
    auth,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteBoardCard(
  auth: AuthMode,
  workspace: string,
  cardId: string,
): Promise<Board> {
  return request(
    `/api/board/cards/${encodeURIComponent(cardId)}${boardQs(workspace)}`,
    auth,
    { method: "DELETE" },
  );
}

export function uploadBoardAttachment(
  auth: AuthMode,
  workspace: string,
  cardId: string,
  input: { name: string; mimeType: string; data: string },
): Promise<Board> {
  return request(
    `/api/board/cards/${encodeURIComponent(cardId)}/attachments${boardQs(workspace)}`,
    auth,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteBoardAttachment(
  auth: AuthMode,
  workspace: string,
  cardId: string,
  attachmentId: string,
): Promise<Board> {
  return request(
    `/api/board/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}${boardQs(workspace)}`,
    auth,
    { method: "DELETE" },
  );
}

export function boardAttachmentUrl(
  auth: AuthMode,
  workspace: string,
  cardId: string,
  attachmentId: string,
  opts?: { download?: boolean },
): string {
  const params = new URLSearchParams({ workspace });
  if (auth.accessToken) params.set("token", auth.accessToken);
  if (opts?.download) params.set("download", "1");
  return `/api/board/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}?${params}`;
}

export function saveMcp(
  auth: AuthMode,
  servers: Record<string, unknown>,
): Promise<{ ok: boolean; servers: Record<string, unknown> }> {
  return request("/api/mcp", auth, {
    method: "PUT",
    body: JSON.stringify({ servers }),
  });
}

export function rollbackMessage(
  auth: AuthMode,
  sessionId: string,
  messageId: string,
): Promise<{
  messages: ChatMessage[];
  filesRestored: boolean;
  filesError?: string;
  restoredPrompt: string;
}> {
  return request(
    `/api/sessions/${sessionId}/messages/${encodeURIComponent(messageId)}/rollback`,
    auth,
    { method: "POST" },
  );
}

export type ModelOption = {
  id: string;
  displayName: string;
  description?: string;
};

export function listModels(auth: AuthMode): Promise<ModelOption[]> {
  return request("/api/models", auth);
}

export type WhisperStatus = {
  enabled: boolean;
  ready: boolean;
  starting: boolean;
  model: string | null;
  device: string | null;
  error: string | null;
};

export async function getTranscribeStatus(auth: AuthMode): Promise<WhisperStatus> {
  return request("/api/transcribe/status", auth);
}

export async function transcribeAudio(
  auth: AuthMode,
  input: { audio: string; mimeType: string; language?: string | null },
): Promise<{ transcription: string; language?: string | null }> {
  return request("/api/transcribe", auth, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteSession(auth: AuthMode, id: string): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${id}`, auth, { method: "DELETE" });
}

/** URL for workspace media (img/video src) or file download. Auth via query token. */
export function sessionMediaUrl(
  auth: AuthMode,
  sessionId: string,
  filePath: string,
  options?: { download?: boolean },
): string {
  const url = new URL(
    `/api/sessions/${encodeURIComponent(sessionId)}/media`,
    window.location.origin,
  );
  url.searchParams.set("path", filePath);
  if (options?.download) {
    url.searchParams.set("download", "1");
  }
  if (auth.accessToken) {
    url.searchParams.set("token", auth.accessToken);
  }
  return url.pathname + url.search;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
const CHAT_MEDIA_PREFIX_RE = /^chat-media\//i;

/** Keep Windows / local paths that react-markdown would otherwise strip (C: → empty). */
export function chatUrlTransform(url: string): string {
  const u = url.trim();
  if (!u) return u;
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (/^javascript:/i.test(u)) return "";
  if (
    /^[a-zA-Z]:[\\/]/.test(u) ||
    u.startsWith("/") ||
    u.startsWith("./") ||
    u.startsWith("../") ||
    CHAT_MEDIA_PREFIX_RE.test(u) ||
    /^file:/i.test(u)
  ) {
    return u;
  }
  return u;
}

function cleanLocalPath(path: string): string {
  let cleaned = path.trim().replace(/^["'`]+|["'`]+$/g, "");
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    /* keep */
  }
  cleaned = cleaned.replace(/\\/g, "/");
  if (/^file:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^file:\/\//i, "");
    if (/^\/[A-Za-z]:\//.test(cleaned)) cleaned = cleaned.slice(1);
  }
  return cleaned;
}

export function isImageMediaPath(path: string): boolean {
  const cleaned = cleanLocalPath(path);
  if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith("data:")) {
    return false;
  }
  return IMAGE_EXT_RE.test(cleaned.split("?")[0] || cleaned);
}

export function isVideoMediaPath(path: string): boolean {
  const cleaned = cleanLocalPath(path);
  if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith("data:")) {
    return false;
  }
  return VIDEO_EXT_RE.test(cleaned.split("?")[0] || cleaned);
}

export function isMediaPath(path: string): boolean {
  return isImageMediaPath(path) || isVideoMediaPath(path);
}

/** True for local (non-http) paths that should render as a download chip. */
export function isDownloadableFilePath(path: string): boolean {
  const cleaned = cleanLocalPath(path);
  if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith("data:")) {
    return false;
  }
  if (isMediaPath(cleaned)) return false;
  const bare = cleaned.split("?")[0] || cleaned;
  // Explicit session store share
  if (CHAT_MEDIA_PREFIX_RE.test(bare)) return true;
  // Markdown-linked local file with an extension (avoid bare words / URLs)
  if (!/\.[A-Za-z0-9]{1,12}$/.test(bare)) return false;
  // Absolute / relative path-ish, or simple filename with extension
  return (
    /^[A-Za-z]:\//.test(bare) ||
    bare.startsWith("/") ||
    bare.startsWith("./") ||
    bare.startsWith("../") ||
    bare.includes("/") ||
    /^[\w.\-()+@]+\.[A-Za-z0-9]{1,12}$/.test(bare)
  );
}

export function fileBasename(path: string): string {
  const cleaned = cleanLocalPath(path);
  const bare = cleaned.split("?")[0] || cleaned;
  const parts = bare.split("/");
  return parts[parts.length - 1] || bare;
}

/** Collect media paths mentioned in assistant text (markdown + bare / backtick paths). */
export function extractMediaPathsFromText(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const path = cleanLocalPath(raw);
    if (!isMediaPath(path)) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(path);
  };

  for (const match of text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) {
    add(match[1] || "");
  }
  for (const match of text.matchAll(
    /`([^`\n]+\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|webm|mov|m4v))`/gi,
  )) {
    add(match[1] || "");
  }
  for (const match of text.matchAll(
    /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[\w.-]+[\\/])[^\s*'"`<>]+\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|webm|mov|m4v))/gi,
  )) {
    add(match[1] || "");
  }

  return found;
}

/**
 * Collect downloadable (non-image/video) file paths from markdown links and
 * chat-media/ backticks — not bare code paths like `src/foo.ts`.
 */
export function extractDownloadablePathsFromText(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const path = cleanLocalPath(raw);
    if (!isDownloadableFilePath(path)) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(path);
  };

  for (const match of text.matchAll(/(!?)\[([^\]]*)]\(([^)\s]+)\)/g)) {
    if (match[1] === "!") continue;
    add(match[3] || "");
  }
  for (const match of text.matchAll(/`(chat-media\/[^`\n]+)`/gi)) {
    add(match[1] || "");
  }

  return found;
}

/** @deprecated use extractMediaPathsFromText */
export function extractImagePathsFromText(text: string): string[] {
  return extractMediaPathsFromText(text).filter(isImageMediaPath);
}

export type FsEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
};

export type FsListing = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  roots: string[];
  shortcuts?: { label: string; path: string }[];
  warning?: string;
};

export function listFs(
  auth: AuthMode,
  path?: string,
  options?: { includeFiles?: boolean },
): Promise<FsListing> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (options?.includeFiles) params.set("files", "1");
  const qs = params.toString();
  return request(`/api/fs${qs ? `?${qs}` : ""}`, auth);
}

export type ConfigDocSource = "user" | "project" | "builtin";
export type ConfigDocKind = "rule" | "skill";

export type ConfigDocSummary = {
  id: string;
  name: string;
  source: ConfigDocSource;
  kind: ConfigDocKind;
  path: string;
  description?: string;
};

export type ConfigDocDetail = ConfigDocSummary & { content: string };

export function listConfigRules(
  auth: AuthMode,
  workspace?: string,
): Promise<{ items: ConfigDocSummary[] }> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  return request(`/api/config/rules${qs}`, auth);
}

export function listConfigSkills(
  auth: AuthMode,
  workspace?: string,
): Promise<{ items: ConfigDocSummary[] }> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  return request(`/api/config/skills${qs}`, auth);
}

export function getConfigDoc(
  auth: AuthMode,
  path: string,
  workspace?: string,
): Promise<ConfigDocDetail> {
  const params = new URLSearchParams({ path });
  if (workspace) params.set("workspace", workspace);
  return request(`/api/config/doc?${params}`, auth);
}

export type SocketHandle = {
  close: () => void;
  /** Force a fresh socket (zombie connections after long background). */
  reconnectNow: () => void;
};

function buildWsUrl(auth: AuthMode): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${proto}//${window.location.host}/ws`);
  if (auth.accessToken) {
    url.searchParams.set("token", auth.accessToken);
  }
  return url.toString();
}

/** Persistent WebSocket with app-level ping and auto-reconnect (CloudPub-friendly). */
export function connectSocket(
  auth: AuthMode,
  onEvent: (event: StreamEvent) => void,
  onConnectionChange?: (state: "open" | "reconnecting" | "closed") => void,
): SocketHandle {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let pingTimer: number | undefined;
  let attempt = 0;
  let lastRxAt = Date.now();
  /** Bumped on each open so stale close handlers from a forced reconnect are ignored. */
  let connGen = 0;

  const clearTimers = () => {
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (pingTimer !== undefined) {
      window.clearInterval(pingTimer);
      pingTimer = undefined;
    }
  };

  const detach = () => {
    clearTimers();
    if (!socket) return;
    const ws = socket;
    socket = null;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      /* ignore */
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    onConnectionChange?.("reconnecting");
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
  };

  const open = () => {
    if (stopped) return;
    const myGen = ++connGen;
    detach();

    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl(auth));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      if (myGen !== connGen) return;
      attempt = 0;
      lastRxAt = Date.now();
      onConnectionChange?.("open");
      pingTimer = window.setInterval(() => {
        if (myGen !== connGen || ws.readyState !== WebSocket.OPEN) return;
        // Zombie socket: looks open but no frames after long suspend.
        if (Date.now() - lastRxAt > 45_000) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        try {
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
        } catch {
          /* ignore */
        }
      }, 20_000);
    });

    ws.addEventListener("message", (ev) => {
      if (myGen !== connGen) return;
      lastRxAt = Date.now();
      try {
        const data = JSON.parse(String(ev.data)) as StreamEvent;
        if (data.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong", t: data.t ?? Date.now() }));
          }
          return;
        }
        if (data.type === "pong") return;
        onEvent(data);
      } catch {
        /* ignore non-JSON / corrupted frames */
      }
    });

    ws.addEventListener("close", () => {
      if (myGen !== connGen) return;
      clearTimers();
      if (socket === ws) socket = null;
      if (stopped) {
        onConnectionChange?.("closed");
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event follows; reconnect there
    });
  };

  open();

  return {
    close: () => {
      stopped = true;
      connGen += 1;
      detach();
      onConnectionChange?.("closed");
    },
    reconnectNow: () => {
      if (stopped) return;
      attempt = 0;
      clearTimers();
      open();
    },
  };
}
