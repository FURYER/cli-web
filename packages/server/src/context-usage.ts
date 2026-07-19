import type { TokenUsage } from "@cursor/sdk";
import { listRules, listSkills, readConfigDoc } from "./cursor-config.js";
import { loadMcpServers } from "./mcp.js";

export const CONTEXT_WINDOW_TOKENS = 256_000;

/** SDK billed totals above this vs window are treated as multi-call sums, not prompt size. */
const PLAUSIBLE_USAGE_FACTOR = 1.25;

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
  /** True when ring uses local estimate because SDK usage looked cumulative. */
  estimated?: boolean;
};

type ChatLike = {
  content?: string;
  role?: string;
  detail?: string;
  activityKind?: string;
  toolName?: string;
};

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(0, Math.ceil(text.length / 4));
}

/**
 * Best-effort single-prompt size from a TokenUsage row.
 * Cursor often reports input≈cache (double-count) and/or sums every model call in the turn.
 */
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

export function usageLooksPlausibleForWindow(
  tokens: number,
  maxTokens = CONTEXT_WINDOW_TOKENS,
): boolean {
  return tokens > 0 && tokens <= maxTokens * PLAUSIBLE_USAGE_FACTOR;
}

async function measureRulesTokens(workspace?: string): Promise<number> {
  try {
    const rules = await listRules(workspace);
    let total = 0;
    for (const rule of rules) {
      try {
        const doc = await readConfigDoc(rule.path, workspace);
        total += estimateTokensFromText(doc.content);
      } catch {
        /* skip */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function measureSkillsTokens(workspace?: string): Promise<number> {
  try {
    const skills = await listSkills(workspace);
    let total = 0;
    for (const skill of skills) {
      total += estimateTokensFromText(`${skill.name}\n${skill.description ?? ""}`);
    }
    return total;
  } catch {
    return 0;
  }
}

async function measureMcpTokens(): Promise<number> {
  try {
    const servers = await loadMcpServers();
    const keys = Object.keys(servers);
    if (!keys.length) return 0;
    const raw = JSON.stringify(servers);
    return Math.max(estimateTokensFromText(raw), keys.length * 800);
  } catch {
    return 0;
  }
}

function measureDynamicToolsTokens(messages: ChatLike[]): number {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.activityKind === "tool" && msg.toolName?.trim()) {
      names.add(msg.toolName.trim().toLowerCase());
    }
    // Labels like "Read path" — keep toolName when present only.
  }
  if (!names.size) return 0;
  // Rough schema+description cost per distinct tool seen this session.
  return names.size * 400;
}

function measureConversationBuckets(messages: ChatLike[]): {
  summarized: number;
  conversation: number;
} {
  let summarized = 0;
  let conversation = 0;
  for (const msg of messages) {
    const tokens =
      estimateTokensFromText(msg.content ?? "") +
      estimateTokensFromText(msg.detail ?? "");
    if (!tokens) continue;
    if (
      msg.activityKind === "summary" ||
      msg.role === "system" ||
      /^summary\b/i.test(msg.content ?? "")
    ) {
      summarized += tokens;
    } else {
      conversation += tokens;
    }
  }
  return { summarized, conversation };
}

function fitCategories(
  categories: ContextCategory[],
  usedTokens: number,
): ContextCategory[] {
  const positive = categories
    .map((c) => ({ ...c, tokens: Math.max(0, Math.round(c.tokens)) }))
    .filter((c) => c.tokens > 0 || c.id === "conversation");

  const sum = positive.reduce((acc, c) => acc + c.tokens, 0);
  if (usedTokens <= 0) {
    return positive.map((c) => ({ ...c, tokens: 0 }));
  }
  if (sum <= 0) {
    return [{ id: "conversation", label: "Conversation", tokens: usedTokens }];
  }

  if (sum === usedTokens) return positive;

  const scaled = positive.map((c) => ({
    ...c,
    tokens: Math.max(0, Math.round((c.tokens / sum) * usedTokens)),
  }));
  const scaledSum = scaled.reduce((acc, c) => acc + c.tokens, 0);
  const delta = usedTokens - scaledSum;
  if (delta !== 0 && scaled.length) {
    const conv =
      scaled.find((c) => c.id === "conversation") ?? scaled[scaled.length - 1];
    conv.tokens = Math.max(0, conv.tokens + delta);
  }
  return scaled.filter((c) => c.tokens > 0);
}

/**
 * Categories aligned with Cursor agent context usage:
 * System Prompt, Tool Definitions, Rules, Skills, MCP, Dynamic Tools,
 * Subagent Definitions, Summarized Conversation, Conversation.
 */
export async function buildContextSnapshot(input: {
  usage: TokenUsage;
  workspace?: string;
  mode?: "agent" | "plan";
  messages?: ChatLike[];
}): Promise<ContextSnapshot> {
  const maxTokens = CONTEXT_WINDOW_TOKENS;
  const fromUsage = promptTokensFromUsage(input.usage);
  const messages = input.messages ?? [];

  const [rules, skills, mcp] = await Promise.all([
    measureRulesTokens(input.workspace),
    measureSkillsTokens(input.workspace),
    measureMcpTokens(),
  ]);
  const { summarized, conversation } = measureConversationBuckets(messages);
  const dynamicTools = measureDynamicToolsTokens(messages);

  const systemPrompt = 3_500;
  const toolDefinitions = input.mode === "plan" ? 9_000 : 16_000;
  const subagentDefinitions = 1_200;

  const raw: ContextCategory[] = [
    { id: "system", label: "System Prompt", tokens: systemPrompt },
    { id: "tools", label: "Tool Definitions", tokens: toolDefinitions },
    { id: "rules", label: "Rules", tokens: rules },
    { id: "skills", label: "Skills", tokens: skills },
    { id: "mcp", label: "MCP", tokens: mcp },
    { id: "dynamic_tools", label: "Dynamic Tools", tokens: dynamicTools },
    {
      id: "subagents",
      label: "Subagent Definitions",
      tokens: subagentDefinitions,
    },
    {
      id: "summarized",
      label: "Summarized Conversation",
      tokens: summarized,
    },
    {
      id: "conversation",
      label: "Conversation",
      tokens: Math.max(conversation, 1),
    },
  ];

  const estimated = raw.reduce((acc, c) => acc + Math.max(0, c.tokens), 0);
  const plausible = usageLooksPlausibleForWindow(fromUsage, maxTokens);
  const usedTokens = plausible ? fromUsage : Math.max(estimated, 1);
  const estimatedFlag = !plausible;

  return {
    usedTokens,
    maxTokens,
    percent: maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 10 : 0,
    categories: plausible
      ? fitCategories(raw, usedTokens)
      : raw.filter((c) => c.tokens > 0),
    estimated: estimatedFlag,
  };
}

export function emptyContextSnapshot(): ContextSnapshot {
  return {
    usedTokens: 0,
    maxTokens: CONTEXT_WINDOW_TOKENS,
    percent: 0,
    categories: [],
  };
}
