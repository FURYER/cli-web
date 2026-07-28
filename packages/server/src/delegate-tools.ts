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
        "Set wake_on_done=true to wake you as soon as THIS child finishes, even if " +
        "other siblings are still running (you can mark several children this way). " +
        "Default wake waits until the whole parallel batch is idle. " +
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
          wake_on_done: {
            type: "boolean",
            description:
              "If true (and wait is false), wake the orchestrator as soon as this " +
              "child finishes — even while other sub-agents are still running. " +
              "Default false: wake once the whole batch is idle.",
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
            wake_on_done?: boolean;
            wakeOnDone?: boolean;
          };
          const result = await spawnDelegatedChild(sessionId, {
            title: String(raw.title || ""),
            prompt: String(raw.prompt || ""),
            model: raw.model,
            wait: Boolean(raw.wait),
            wakeOnDone: Boolean(raw.wake_on_done ?? raw.wakeOnDone),
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

    wake_on_child_done: {
      description:
        "Mark a running (or already finished) sub-agent so it wakes you as soon " +
        "as it finishes, without waiting for sibling sub-agents. " +
        "Pass enabled=false to clear early-wake and go back to batch wake. " +
        "If the child already finished and enabled=true, queues an early wake now.",
      inputSchema: {
        type: "object",
        properties: {
          childSessionId: {
            type: "string",
            description: "Id returned by delegate_task",
          },
          enabled: {
            type: "boolean",
            description: "Default true — set false to disable early wake for this child",
          },
        },
        required: ["childSessionId"],
      },
      execute: async (args) => {
        try {
          const { setChildWakeOnDone } = await import("./agent.js");
          const raw = args as { childSessionId?: string; enabled?: boolean };
          const result = await setChildWakeOnDone(
            sessionId,
            String(raw.childSessionId || ""),
            raw.enabled !== false,
          );
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
