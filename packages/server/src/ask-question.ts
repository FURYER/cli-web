import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { notifyAskWaiting } from "./push.js";

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

export type AskQuestionArgs = {
  title?: string;
  questions: AskQuestionItem[];
};

export type AskQuestionAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  freeformText?: string;
};

export type AskQuestionHandlerResult =
  | { outcome: "answered"; answers: AskQuestionAnswer[] }
  | { outcome: "skipped"; reason?: string };

export type AskQuestionPrompt = {
  callId: string;
  toolCallId: string;
  title?: string;
  questions: AskQuestionItem[];
};

type PendingAsk = {
  sessionId: string;
  prompt: AskQuestionPrompt;
  resolve: (result: AskQuestionHandlerResult) => void;
};

type SdkAskPayload = {
  id?: string;
  toolCallId?: string;
  args?: unknown;
};

type Broadcaster = (event: {
  type: "ask_question";
  sessionId: string;
  callId: string;
  toolCallId: string;
  title?: string;
  questions: AskQuestionItem[];
  status: "pending" | "answered" | "skipped";
  answers?: AskQuestionAnswer[];
}) => void;

const sessionAls = new AsyncLocalStorage<string>();
const busyAskSessions = new Set<string>();
const pendingByCallId = new Map<string, PendingAsk>();
/** In-flight promises for HTTP/MCP wait. */
const waitersByCallId = new Map<string, Promise<AskQuestionHandlerResult>>();
/** Settled results kept briefly so HTTP wait / MCP can read after answer. */
const settledByCallId = new Map<
  string,
  { sessionId: string; result: AskQuestionHandlerResult; at: number }
>();
const SETTLE_TTL_MS = 30 * 60 * 1000;
let broadcast: Broadcaster = () => {};

declare global {
  // eslint-disable-next-line no-var
  var __cursorCliAskQuestion:
    | ((payload: SdkAskPayload) => Promise<AskQuestionHandlerResult>)
    | undefined;
}

export function beginAskSession(sessionId: string): void {
  busyAskSessions.add(sessionId);
}

export function endAskSession(sessionId: string): void {
  busyAskSessions.delete(sessionId);
}

function resolveActiveSessionId(): string | undefined {
  return (
    sessionAls.getStore() ??
    (busyAskSessions.size === 1 ? [...busyAskSessions][0] : undefined)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOptions(raw: unknown): AskQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestionOption[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item === "string") {
      const label = item.trim();
      if (!label) continue;
      out.push({ id: `opt_${index + 1}`, label });
      continue;
    }
    const row = asRecord(item);
    if (!row) continue;
    const id =
      (typeof row.id === "string" && row.id) ||
      (typeof row.value === "string" && row.value) ||
      "";
    const label =
      (typeof row.label === "string" && row.label) ||
      (typeof row.text === "string" && row.text) ||
      (typeof row.title === "string" && row.title) ||
      id;
    if (!id && !label) continue;
    out.push({ id: id || `opt_${index + 1}`, label: label || id });
  }
  return out;
}

function parseQuestions(raw: unknown): AskQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestionItem[] = [];
  for (const [index, item] of raw.entries()) {
    const row = asRecord(item);
    if (!row) continue;
    const id =
      (typeof row.id === "string" && row.id) ||
      (typeof row.questionId === "string" && row.questionId) ||
      `q_${index + 1}`;
    const prompt =
      (typeof row.prompt === "string" && row.prompt) ||
      (typeof row.question === "string" && row.question) ||
      (typeof row.text === "string" && row.text) ||
      (typeof row.title === "string" && row.title) ||
      "";
    if (!prompt.trim()) continue;
    const options = parseOptions(row.options ?? row.choices ?? row.answers);
    const allowMultiple = Boolean(
      row.allowMultiple ?? row.allow_multiple ?? row.allowMultipleSelections,
    );
    out.push({ id, prompt: prompt.trim(), options, allowMultiple });
  }
  return out;
}

export function parseAskQuestionArgs(raw: unknown): AskQuestionArgs | null {
  const row = asRecord(raw);
  if (!row) return null;
  // Some SDK payloads nest under `.args`
  const nested = asRecord(row.args);
  const source = nested && (nested.questions || nested.items) ? nested : row;
  const questions = parseQuestions(
    source.questions ?? source.items ?? source.prompts ?? source.qs,
  );
  if (questions.length === 0) return null;
  const title =
    (typeof source.title === "string" && source.title) ||
    (typeof source.name === "string" && source.name) ||
    (typeof row.title === "string" && row.title) ||
    undefined;
  return { title, questions };
}

export function setAskQuestionBroadcaster(fn: Broadcaster): void {
  broadcast = fn;
}

export function runWithAskSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return sessionAls.run(sessionId, fn);
}

export function installAskQuestionHook(): void {
  globalThis.__cursorCliAskQuestion = handleSdkAskQuestion;
}

export function uninstallAskQuestionHook(): void {
  if (globalThis.__cursorCliAskQuestion === handleSdkAskQuestion) {
    globalThis.__cursorCliAskQuestion = undefined;
  }
}

function rememberSettled(
  sessionId: string,
  callId: string,
  result: AskQuestionHandlerResult,
): void {
  settledByCallId.set(callId, { sessionId, result, at: Date.now() });
  // Opportunistic cleanup
  const cutoff = Date.now() - SETTLE_TTL_MS;
  for (const [id, entry] of settledByCallId) {
    if (entry.at < cutoff) settledByCallId.delete(id);
  }
}

/**
 * Show AskQuestionCard in the WebCLI UI and wait for the user's answer.
 * Used by the SDK hook and by the ask_user MCP HTTP path.
 */
export function promptUserQuestions(
  sessionId: string,
  args: AskQuestionArgs,
  options?: { callId?: string; toolCallId?: string },
): Promise<AskQuestionHandlerResult> {
  const callId = options?.callId?.trim() || randomUUID();
  const toolCallId = options?.toolCallId?.trim() || callId;

  const prompt: AskQuestionPrompt = {
    callId,
    toolCallId,
    title: args.title,
    questions: args.questions,
  };

  broadcast({
    type: "ask_question",
    sessionId,
    callId,
    toolCallId,
    title: prompt.title,
    questions: prompt.questions,
    status: "pending",
  });

  void notifyAskWaiting({
    sessionId,
    questionTitle: prompt.title || prompt.questions[0]?.prompt,
  });

  return new Promise<AskQuestionHandlerResult>((resolve) => {
    pendingByCallId.set(callId, {
      sessionId,
      prompt,
      resolve: (result) => {
        rememberSettled(sessionId, callId, result);
        resolve(result);
      },
    });
  });
}

/** Start a question without awaiting — returns callId for HTTP wait. */
export function startUserQuestions(
  sessionId: string,
  args: AskQuestionArgs,
): { callId: string; done: Promise<AskQuestionHandlerResult> } {
  const callId = randomUUID();
  const done = promptUserQuestions(sessionId, args, { callId, toolCallId: callId });
  waitersByCallId.set(callId, done);
  void done.finally(() => {
    // Keep settled entry; drop waiter after a tick so wait can still attach.
    setTimeout(() => waitersByCallId.delete(callId), 5_000);
  });
  return { callId, done };
}

export async function waitForUserQuestions(
  sessionId: string,
  callId: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<AskQuestionHandlerResult> {
  const settled = settledByCallId.get(callId);
  if (settled) {
    if (settled.sessionId !== sessionId) {
      throw new Error("AskQuestion does not belong to this session");
    }
    return settled.result;
  }

  const pending = pendingByCallId.get(callId);
  if (pending && pending.sessionId !== sessionId) {
    throw new Error("AskQuestion does not belong to this session");
  }

  const waiter = waitersByCallId.get(callId);
  if (!waiter && !pending) {
    throw new Error("AskQuestion not found or already answered");
  }

  const work =
    waiter ??
    new Promise<AskQuestionHandlerResult>((resolve, reject) => {
      const check = setInterval(() => {
        const done = settledByCallId.get(callId);
        if (done) {
          clearInterval(check);
          if (done.sessionId !== sessionId) {
            reject(new Error("AskQuestion does not belong to this session"));
            return;
          }
          resolve(done.result);
        } else if (!pendingByCallId.has(callId)) {
          clearInterval(check);
          reject(new Error("AskQuestion not found or already answered"));
        }
      }, 200);
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<AskQuestionHandlerResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for user answers")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleSdkAskQuestion(
  payload: SdkAskPayload,
): Promise<AskQuestionHandlerResult> {
  const sessionId = resolveActiveSessionId();
  console.info(
    "[ask-question] SDK hook",
    JSON.stringify({
      sessionId: sessionId ?? null,
      id: payload.id ?? null,
      toolCallId: payload.toolCallId ?? null,
      hasArgs: payload.args != null,
    }),
  );

  const args = parseAskQuestionArgs(payload.args);
  if (!sessionId || !args) {
    const reason = sessionId
      ? "Invalid AskQuestion payload"
      : "Interactive questions are not supported in local SDK runs";
    if (!args) {
      try {
        console.warn(
          "[ask-question] skipped invalid payload",
          JSON.stringify(payload.args)?.slice(0, 800),
        );
      } catch {
        console.warn("[ask-question] skipped invalid payload (unserializable)");
      }
    } else if (!sessionId) {
      console.warn("[ask-question] skipped: no active session");
    }
    return { outcome: "skipped", reason };
  }

  const callId =
    (typeof payload.id === "string" && payload.id) ||
    (typeof payload.toolCallId === "string" && payload.toolCallId) ||
    randomUUID();
  const toolCallId =
    (typeof payload.toolCallId === "string" && payload.toolCallId) || callId;

  return promptUserQuestions(sessionId, args, { callId, toolCallId });
}

export function answerAskQuestion(
  sessionId: string,
  callId: string,
  result: AskQuestionHandlerResult,
): AskQuestionPrompt {
  const pending = pendingByCallId.get(callId);
  if (!pending) throw new Error("AskQuestion not found or already answered");
  if (pending.sessionId !== sessionId) {
    throw new Error("AskQuestion does not belong to this session");
  }

  pendingByCallId.delete(callId);
  pending.resolve(result);

  broadcast({
    type: "ask_question",
    sessionId,
    callId,
    toolCallId: pending.prompt.toolCallId,
    title: pending.prompt.title,
    questions: pending.prompt.questions,
    status: result.outcome === "answered" ? "answered" : "skipped",
    answers: result.outcome === "answered" ? result.answers : undefined,
  });

  return pending.prompt;
}

export function cancelAskQuestionsForSession(sessionId: string, reason = "Cancelled"): void {
  for (const [callId, pending] of pendingByCallId) {
    if (pending.sessionId !== sessionId) continue;
    pendingByCallId.delete(callId);
    pending.resolve({ outcome: "skipped", reason });
    broadcast({
      type: "ask_question",
      sessionId,
      callId,
      toolCallId: pending.prompt.toolCallId,
      title: pending.prompt.title,
      questions: pending.prompt.questions,
      status: "skipped",
    });
  }
}

export function listPendingAskQuestions(sessionId: string): AskQuestionPrompt[] {
  const out: AskQuestionPrompt[] = [];
  for (const pending of pendingByCallId.values()) {
    if (pending.sessionId === sessionId) out.push(pending.prompt);
  }
  return out;
}

export function hasPendingAskQuestions(sessionId?: string): boolean {
  if (!sessionId) return pendingByCallId.size > 0;
  for (const pending of pendingByCallId.values()) {
    if (pending.sessionId === sessionId) return true;
  }
  return false;
}
