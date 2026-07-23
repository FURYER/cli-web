import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import {
  deleteMemory,
  getMemory,
  listMemory,
  setMemory,
} from "./memory.js";
import {
  deleteSecret,
  getSecret,
  listSecrets,
  setSecret,
} from "./secrets.js";

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, SDKJsonValue>,
    ...(isError ? { isError: true } : {}),
  };
}

/** In-process tools for ~/.webcli/memory.json and encrypted secrets.json. */
export function createMemorySecretTools(): Record<string, SDKCustomTool> {
  return {
    memory: {
      description:
        "Persistent WebCLI long-term memory (~/.webcli/memory.json, cross-session). " +
        "Store ANY durable fact the user wants remembered: preferences, decisions, URLs, " +
        "project context, people, workflow notes, Meshy model links, etc. " +
        "NOT for passwords/API tokens — use `secret` for those. " +
        "Actions: list, get, set, delete.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "get", "set", "delete"],
            description: "list | get | set | delete",
          },
          key: {
            type: "string",
            description: "Entry key (required for get/set/delete)",
          },
          value: {
            type: "string",
            description: "Value to store (required for set)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for set; filter for list",
          },
          tag: {
            type: "string",
            description: "Optional tag filter when action=list",
          },
        },
        required: ["action"],
      },
      execute: async (args) => {
        try {
          const raw = args as {
            action?: string;
            key?: string;
            value?: string;
            tags?: string[];
            tag?: string;
          };
          const action = String(raw.action || "");
          if (action === "list") {
            return textResult({
              entries: await listMemory(raw.tag || raw.tags?.[0]),
            });
          }
          if (action === "get") {
            const entry = await getMemory(String(raw.key || ""));
            return textResult({ entry });
          }
          if (action === "set") {
            const entry = await setMemory({
              key: String(raw.key || ""),
              value: String(raw.value ?? ""),
              tags: raw.tags,
            });
            return textResult({ entry });
          }
          if (action === "delete") {
            const ok = await deleteMemory(String(raw.key || ""));
            return textResult({ ok });
          }
          return textResult(
            { error: `Unknown action: ${action}` },
            true,
          );
        } catch (err) {
          return textResult(
            { error: err instanceof Error ? err.message : String(err) },
            true,
          );
        }
      },
    },

    secret: {
      description:
        "Encrypted WebCLI secrets vault (~/.webcli/secrets.json, AES-256-GCM via ACCESS_TOKEN). " +
        "Store passwords/API tokens. Never echo secret values back to the user in chat. " +
        "Use values only to fill login forms. Actions: list (keys only), get, set, delete.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "get", "set", "delete"],
            description: "list | get | set | delete",
          },
          key: {
            type: "string",
            description: "Secret key (required for get/set/delete)",
          },
          value: {
            type: "string",
            description: "Secret value (required for set)",
          },
        },
        required: ["action"],
      },
      execute: async (args) => {
        try {
          const raw = args as {
            action?: string;
            key?: string;
            value?: string;
          };
          const action = String(raw.action || "");
          if (action === "list") {
            return textResult({ entries: await listSecrets() });
          }
          if (action === "get") {
            const entry = await getSecret(String(raw.key || ""));
            return textResult({ entry });
          }
          if (action === "set") {
            const meta = await setSecret({
              key: String(raw.key || ""),
              value: String(raw.value ?? ""),
            });
            return textResult({ entry: meta });
          }
          if (action === "delete") {
            const ok = await deleteSecret(String(raw.key || ""));
            return textResult({ ok });
          }
          return textResult(
            { error: `Unknown action: ${action}` },
            true,
          );
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
