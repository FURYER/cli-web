import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, SDKJsonValue>,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Orchestrator tools: spawn isolated worktree sub-agents, inspect results, merge branches.
 * Loaded only for parent sessions (not for children).
 */
export function createSubagentTools(sessionId: string): Record<string, SDKCustomTool> {
  return {
    delegate_task: {
      description:
        "Delegate a task to a sub-agent in an isolated git worktree + branch. " +
        "Before spawning, the parent workspace is prepared: if git is dirty, " +
        "a checkpoint commit is created so the child sees current files. " +
        "Fails if the folder is not a git repo or a merge/rebase is in progress. " +
        "Set wait=true to block until it finishes; otherwise it runs in parallel. " +
        "After children finish, review with get_child_result then merge_child.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short label for the sub-agent chat",
          },
          prompt: {
            type: "string",
            description: "Full task instructions for the sub-agent",
          },
          model: {
            type: "string",
            description: "Optional model id override",
          },
          wait: {
            type: "boolean",
            description: "If true, wait until the sub-agent finishes (default false)",
          },
        },
        required: ["title", "prompt"],
      },
      execute: async (args) => {
        try {
          const { spawnDelegatedChild } = await import("./agent.js");
          const raw = args as {
            title?: string;
            prompt?: string;
            model?: string;
            wait?: boolean;
          };
          const result = await spawnDelegatedChild(sessionId, {
            title: String(raw.title || ""),
            prompt: String(raw.prompt || ""),
            model: raw.model,
            wait: Boolean(raw.wait),
          });
          return textResult(result);
        } catch (err) {
          return textResult(
            { error: err instanceof Error ? err.message : String(err) },
            true,
          );
        }
      },
    },

    get_child_result: {
      description:
        "Inspect a delegated sub-agent: status, last assistant message, and git branch summary. " +
        "Use before merge_child to review work.",
      inputSchema: {
        type: "object",
        properties: {
          childSessionId: {
            type: "string",
            description: "Id returned by delegate_task",
          },
        },
        required: ["childSessionId"],
      },
      execute: async (args) => {
        try {
          const { getDelegatedChildResult } = await import("./agent.js");
          const childSessionId = String(
            (args as { childSessionId?: string }).childSessionId || "",
          );
          const result = await getDelegatedChildResult(sessionId, childSessionId);
          return textResult(result);
        } catch (err) {
          return textResult(
            { error: err instanceof Error ? err.message : String(err) },
            true,
          );
        }
      },
    },

    merge_child: {
      description:
        "Merge a finished sub-agent's branch into the parent workspace and remove its worktree. " +
        "On conflict, returns conflict details — resolve in the parent repo then retry or abort.",
      inputSchema: {
        type: "object",
        properties: {
          childSessionId: {
            type: "string",
            description: "Id returned by delegate_task",
          },
        },
        required: ["childSessionId"],
      },
      execute: async (args) => {
        try {
          const { mergeDelegatedChild } = await import("./agent.js");
          const childSessionId = String(
            (args as { childSessionId?: string }).childSessionId || "",
          );
          const result = await mergeDelegatedChild(sessionId, childSessionId);
          return textResult(result, !result.ok);
        } catch (err) {
          return textResult(
            { error: err instanceof Error ? err.message : String(err) },
            true,
          );
        }
      },
    },
  };
}
