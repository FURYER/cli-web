/**
 * Detect Cursor / provider quota exhaustion and alert the phone + UI.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sendAlertEmail } from "./mail.js";
import { dataDir } from "./paths.js";
import { notifyPush } from "./push.js";

export type AgentLimitState = {
  active: boolean;
  message: string;
  detail?: string;
  sessionId?: string;
  chatTitle?: string;
  at: number;
};

const FILE = () => join(dataDir(), "agent-limit.json");

let cached: AgentLimitState | null = null;
let lastPushAt = 0;
const PUSH_COOLDOWN_MS = 15 * 60_000;

function errHaystack(err: unknown): string {
  if (err == null) return "";
  const parts: string[] = [];
  if (typeof err === "string") parts.push(err);
  if (err instanceof Error) parts.push(err.name, err.message, err.stack ?? "");
  if (typeof err === "object") {
    const record = err as Record<string, unknown>;
    for (const key of ["code", "message", "error", "reason", "status", "statusCode"] as const) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") parts.push(String(value));
      else if (value instanceof Error) parts.push(value.name, value.message);
      else if (value && typeof value === "object" && "message" in value) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === "string") parts.push(nested);
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

/** True when the failure is likely billing / rate / quota — not a code bug. */
export function isQuotaOrRateLimitFailure(err: unknown): boolean {
  const hay = errHaystack(err);
  if (!hay) return false;
  return (
    hay.includes("rate limit") ||
    hay.includes("ratelimit") ||
    hay.includes("rate_limit") ||
    hay.includes("too many requests") ||
    hay.includes("resource_exhausted") ||
    hay.includes("resource exhausted") ||
    hay.includes("insufficient_quota") ||
    hay.includes("insufficient quota") ||
    hay.includes("quota exceeded") ||
    hay.includes("quota_exceeded") ||
    hay.includes("usage limit") ||
    hay.includes("usage_limit") ||
    hay.includes("spending limit") ||
    hay.includes("billing") ||
    hay.includes("out of credits") ||
    hay.includes("credit balance") ||
    /\b429\b/.test(hay) ||
    (hay.includes("limit") &&
      (hay.includes("exceed") ||
        hay.includes("reached") ||
        hay.includes("exhaust") ||
        hay.includes("api key")))
  );
}

export async function loadAgentLimitState(): Promise<AgentLimitState | null> {
  if (cached) return cached.active ? cached : null;
  try {
    const raw = await readFile(FILE(), "utf8");
    cached = JSON.parse(raw) as AgentLimitState;
    return cached.active ? cached : null;
  } catch {
    return null;
  }
}

async function saveState(state: AgentLimitState | null): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  if (!state) {
    cached = { active: false, message: "", at: Date.now() };
    await writeFile(FILE(), JSON.stringify(cached, null, 2), "utf8");
    return;
  }
  cached = state;
  await writeFile(FILE(), JSON.stringify(state, null, 2), "utf8");
}

export async function clearAgentLimitState(): Promise<void> {
  await saveState(null);
}

/**
 * Persist + optional push (cooldown). Returns the state for WS broadcast.
 */
export async function raiseAgentLimitAlert(input: {
  sessionId?: string;
  chatTitle?: string;
  detail?: string;
}): Promise<AgentLimitState> {
  const state: AgentLimitState = {
    active: true,
    message:
      "Лимиты Cursor/API кончились — агент не отвечает. Зайди на сайт и пополни/почини лимиты.",
    detail: input.detail?.slice(0, 500),
    sessionId: input.sessionId,
    chatTitle: input.chatTitle,
    at: Date.now(),
  };
  await saveState(state);

  const now = Date.now();
  if (now - lastPushAt >= PUSH_COOLDOWN_MS) {
    lastPushAt = now;
    const chat = input.chatTitle?.trim() || "Chat";
    const body = `«${chat}» не может ответить — исправь лимиты Cursor/API`;
    await notifyPush({
      title: "Лимиты агента",
      body,
      tag: `webcli-agent-limit`,
      sessionId: input.sessionId,
    });
    const detailLine = input.detail?.trim()
      ? `\n\nДетали: ${input.detail.trim().slice(0, 500)}`
      : "";
    await sendAlertEmail({
      subject: "WebCLI: лимиты агента",
      text: `${state.message}\n\nЧат: ${chat}${detailLine}\n\nВремя: ${new Date(state.at).toISOString()}`,
    });
  }

  return state;
}
