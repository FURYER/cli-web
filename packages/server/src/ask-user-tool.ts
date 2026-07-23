import type { SDKCustomTool, SDKCustomToolContent, SDKJsonValue } from "@cursor/sdk";
import {
  parseAskQuestionArgs,
  promptUserQuestions,
  type AskQuestionHandlerResult,
} from "./ask-question.js";
import { askAnswersForAgent, countAskAttachments } from "./ask-uploads.js";

function asJson(value: unknown): SDKJsonValue {
  return value as unknown as SDKJsonValue;
}

function formatAskToolPayload(result: AskQuestionHandlerResult): Record<string, unknown> {
  if (result.outcome !== "answered") {
    return { ...result };
  }
  const answers = askAnswersForAgent(result.answers);
  const counts = countAskAttachments(result.answers);
  const noteParts: string[] = [];
  if (counts.images || counts.files) {
    noteParts.push(
      "User attached files were saved under .webcli/ask-uploads/. " +
        "Use the returned path fields (Read / open the files) — do not wait for a later agent.send with images.",
    );
  }
  return {
    outcome: "answered",
    answers,
    ...(noteParts.length ? { attachmentNote: noteParts.join(" ") } : {}),
  };
}

/** In-process ask_user tool → same AskQuestionCard UI as the SDK hook. */
export function createAskUserCustomTool(sessionId: string): SDKCustomTool {
  return {
    description:
      "Ask the user interactive multiple-choice questions in the WebCLI chat UI. " +
      "Use this instead of writing questions as plain markdown. Blocks until the user answers or skips. " +
      "Each question already has a freeform text field — do NOT add an option like " +
      "«свой ответ», «другое», «other», or «custom»; only concrete choices. " +
      "The user may attach photos/files with their answer; the tool result includes saved paths " +
      "(and image parts when available) — open/Read those paths.",
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
    execute: async (args) => {
      const parsed = parseAskQuestionArgs(args);
      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Invalid ask_user payload (need questions with prompt + options)",
            },
          ],
          isError: true,
        };
      }
      const result = await promptUserQuestions(sessionId, parsed);
      const payload = formatAskToolPayload(result);
      const content: SDKCustomToolContent[] = [
        { type: "text", text: JSON.stringify(payload, null, 2) },
      ];
      if (result.outcome === "answered") {
        for (const answer of result.answers) {
          for (const img of answer.images ?? []) {
            if (!img.data) continue;
            content.push({
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
            });
          }
        }
      }
      return {
        content,
        structuredContent: asJson(payload) as Record<string, SDKJsonValue>,
      };
    },
  };
}
