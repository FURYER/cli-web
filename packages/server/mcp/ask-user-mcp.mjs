#!/usr/bin/env node
/**
 * Minimal MCP stdio server: ask_user → WebCLI AskQuestionCard via HTTP.
 * Logs only to stderr — stdout is JSON-RPC.
 *
 * Env:
 *   WEBCLI_URL          e.g. http://127.0.0.1:8787
 *   WEBCLI_TOKEN        ACCESS_TOKEN
 *   WEBCLI_SESSION_ID   active chat session id
 */
import { createInterface } from "node:readline";

const URL_BASE = (process.env.WEBCLI_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.WEBCLI_TOKEN || "";
const SESSION_ID = process.env.WEBCLI_SESSION_ID || "";

function log(...args) {
  console.error("[webcli-ask]", ...args);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

const TOOLS = [
  {
    name: "ask_user",
    description:
      "Ask the user interactive multiple-choice questions in the WebCLI chat UI. Use this instead of writing questions as plain markdown. Blocks until the user answers or skips.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional short title for the question card",
        },
        questions: {
          type: "array",
          description: "One or more questions with options",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              allowMultiple: { type: "boolean" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["id", "label"],
                },
              },
            },
            required: ["id", "prompt", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
];

async function handleAskUser(args) {
  if (!SESSION_ID) {
    throw new Error("WEBCLI_SESSION_ID is not set");
  }
  if (!TOKEN) {
    throw new Error("WEBCLI_TOKEN is not set");
  }
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  if (questions.length === 0) {
    throw new Error("questions array is required");
  }

  const created = await api("POST", `/api/sessions/${encodeURIComponent(SESSION_ID)}/questions`, {
    title: typeof args?.title === "string" ? args.title : undefined,
    questions,
  });
  const callId = created?.callId;
  if (!callId) throw new Error("Server did not return callId");

  const result = await api(
    "GET",
    `/api/sessions/${encodeURIComponent(SESSION_ID)}/questions/${encodeURIComponent(callId)}/wait?timeoutMs=${10 * 60 * 1000}`,
  );
  return result;
}

async function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "webcli-ask", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      if (name !== "ask_user") {
        throw new Error(`Unknown tool: ${name}`);
      }
      const result = await handleAskUser(args);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(message);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        },
      });
    }
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (id !== undefined && id !== null) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void onMessage(JSON.parse(trimmed));
  } catch (err) {
    log("parse error", err);
  }
});

log(`ready session=${SESSION_ID || "(none)"} url=${URL_BASE}`);
