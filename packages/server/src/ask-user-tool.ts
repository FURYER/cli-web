import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import {
  parseAskQuestionArgs,
  promptUserQuestions,
  type AskQuestionHandlerResult,
} from "./ask-question.js";

function asJson(value: AskQuestionHandlerResult): SDKJsonValue {
  return value as unknown as SDKJsonValue;
}

/** In-process ask_user tool → same AskQuestionCard UI as the SDK hook. */
export function createAskUserCustomTool(sessionId: string): SDKCustomTool {
  return {
    description:
      "Ask the user interactive multiple-choice questions in the WebCLI chat UI. " +
      "Use this instead of writing questions as plain markdown. Blocks until the user answers or skips. " +
      "Each question already has a freeform text field — do NOT add an option like " +
      "«свой ответ», «другое», «other», or «custom»; only concrete choices.",
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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: asJson(result) as Record<string, SDKJsonValue>,
      };
    },
  };
}
