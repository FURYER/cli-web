import type { ChatMessage, ContextSnapshot, TokenUsage } from "./api";

export const CONTEXT_WINDOW_TOKENS = 256_000;
const PLAUSIBLE_USAGE_FACTOR = 1.25;

export const CONTEXT_CATEGORY_COLORS: Record<string, string> = {
  system: "#7aa2f7",
  tools: "#bb9af7",
  rules: "#e0af68",
  skills: "#9ece6a",
  mcp: "#f7768e",
  dynamic_tools: "#ff9e64",
  subagents: "#2ac3de",
  summarized: "#c0caf5",
  conversation: "#7dcfff",
};

export function colorForCategory(id: string, index: number): string {
  if (CONTEXT_CATEGORY_COLORS[id]) return CONTEXT_CATEGORY_COLORS[id];
  const fallback = ["#7aa2f7", "#bb9af7", "#e0af68", "#9ece6a", "#f7768e", "#2ac3de", "#7dcfff"];
  return fallback[index % fallback.length];
}

/** Single-prompt size from usage; avoids input≈cache double-count. */
export function promptTokensFromUsage(usage: TokenUsage): number {
  const input = Math.max(0, usage.inputTokens || 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens || 0);
  if (input <= 0 && cacheRead <= 0) return 0;
  if (input <= 0) return cacheRead;
  if (cacheRead <= 0) return input;
  const ratio = Math.min(input, cacheRead) / Math.max(input, cacheRead);
  if (ratio >= 0.85) return Math.max(input, cacheRead);
  return input + cacheRead;
}

export function usageLooksPlausible(tokens: number): boolean {
  return tokens > 0 && tokens <= CONTEXT_WINDOW_TOKENS * PLAUSIBLE_USAGE_FACTOR;
}

/** @deprecated use promptTokensFromUsage */
export function contextUsedTokens(usage: TokenUsage): number {
  return promptTokensFromUsage(usage);
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function estimateFromMessages(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
    if (m.detail) chars += m.detail.length;
  }
  // Rough prompt overhead (system + tools) when we distrust SDK totals.
  return Math.ceil(chars / 4) + 25_000;
}

export function snapshotFromUsage(
  usage: TokenUsage,
  context?: ContextSnapshot | null,
  messages?: ChatMessage[],
): ContextSnapshot {
  const fromUsage = promptTokensFromUsage(usage);
  const maxTokens = CONTEXT_WINDOW_TOKENS;

  if (context && usageLooksPlausible(context.usedTokens)) {
    return context;
  }

  if (usageLooksPlausible(fromUsage)) {
    return {
      usedTokens: fromUsage,
      maxTokens,
      percent: Math.round((fromUsage / maxTokens) * 1000) / 10,
      categories: context?.categories?.length
        ? context.categories
        : [{ id: "conversation", label: "Conversation", tokens: fromUsage }],
      estimated: context?.estimated,
    };
  }

  const estimated = messages?.length
    ? estimateFromMessages(messages)
    : Math.min(fromUsage, maxTokens);
  const usedTokens = Math.max(1, estimated);
  return {
    usedTokens,
    maxTokens,
    percent: Math.round((usedTokens / maxTokens) * 1000) / 10,
    categories: [
      { id: "conversation", label: "Conversation", tokens: usedTokens },
    ],
    estimated: true,
  };
}

export function latestContextFromMessages(
  messages: ChatMessage[],
): { usage: TokenUsage; context: ContextSnapshot } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.usage && typeof msg.usage.inputTokens === "number") {
      return {
        usage: msg.usage,
        context: snapshotFromUsage(msg.usage, msg.context, messages),
      };
    }
  }
  return null;
}
