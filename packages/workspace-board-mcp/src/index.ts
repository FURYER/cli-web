#!/usr/bin/env node
/**
 * MCP stdio server for workspace kanban boards.
 * Storage: <workspace>/.webcli/board.json (same file as Web CLI Board UI).
 * Logs only to stderr — stdout is JSON-RPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addCard,
  addColumn,
  deleteCard,
  deleteColumn,
  loadBoard,
  moveCard,
  renameColumn,
  summarizeBoard,
  updateCard,
} from "./board.js";

const server = new McpServer({
  name: "workspace-board",
  version: "1.0.0",
});

const workspaceArg = z
  .string()
  .describe("Absolute path to the project workspace root (contains .webcli/board.json)");

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[workspace-board-mcp]", message);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

server.registerTool(
  "board_get",
  {
    title: "Get task board",
    description:
      "Load the workspace kanban board from .webcli/board.json. Optional card_id (e.g. T-12 or #T-12) returns one card.",
    inputSchema: {
      workspace: workspaceArg,
      card_id: z
        .string()
        .optional()
        .describe("Optional card id like T-12 or #T-12"),
    },
  },
  async ({ workspace, card_id }) => {
    try {
      const board = await loadBoard(workspace);
      if (card_id) {
        const id = card_id.replace(/^#/, "");
        const card = board.cards.find((c) => c.id === id);
        if (!card) throw new Error(`Card not found: ${id}`);
        const col = board.columns.find((c) => c.id === card.columnId);
        return ok(
          JSON.stringify(
            { card, column: col ?? null, path: `${workspace}/.webcli/board.json` },
            null,
            2,
          ),
        );
      }
      return ok(summarizeBoard(board));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_add_card",
  {
    title: "Add board card",
    description: "Create a card (id T-N). Defaults to first column (Inbox) if column_id omitted.",
    inputSchema: {
      workspace: workspaceArg,
      title: z.string().describe("Card title"),
      body: z.string().optional().describe("Optional notes/body"),
      column_id: z.string().optional().describe("Target column id (e.g. col_inbox)"),
    },
  },
  async ({ workspace, title, body, column_id }) => {
    try {
      const board = await addCard(workspace, {
        title,
        body,
        columnId: column_id,
      });
      const card = board.cards[board.cards.length - 1];
      return ok(`Created ${card?.id}: ${card?.title}\n\n${summarizeBoard(board)}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_update_card",
  {
    title: "Update board card",
    description: "Update title and/or body of a card (T-N / #T-N).",
    inputSchema: {
      workspace: workspaceArg,
      card_id: z.string().describe("Card id like T-12"),
      title: z.string().optional(),
      body: z.string().optional(),
    },
  },
  async ({ workspace, card_id, title, body }) => {
    try {
      const board = await updateCard(workspace, card_id, { title, body });
      return ok(`Updated ${card_id.replace(/^#/, "")}\n\n${summarizeBoard(board)}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_move_card",
  {
    title: "Move board card",
    description: "Move a card to another column (and optional order).",
    inputSchema: {
      workspace: workspaceArg,
      card_id: z.string().describe("Card id like T-12"),
      column_id: z.string().describe("Destination column id"),
      order: z.number().optional().describe("Order within the column"),
    },
  },
  async ({ workspace, card_id, column_id, order }) => {
    try {
      const board = await moveCard(workspace, card_id, {
        columnId: column_id,
        order,
      });
      return ok(`Moved ${card_id.replace(/^#/, "")} → ${column_id}\n\n${summarizeBoard(board)}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_delete_card",
  {
    title: "Delete board card",
    description: "Delete a card by id (T-N / #T-N).",
    inputSchema: {
      workspace: workspaceArg,
      card_id: z.string(),
    },
  },
  async ({ workspace, card_id }) => {
    try {
      const board = await deleteCard(workspace, card_id);
      return ok(`Deleted ${card_id.replace(/^#/, "")}\n\n${summarizeBoard(board)}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_add_column",
  {
    title: "Add board column",
    description: "Add a kanban column.",
    inputSchema: {
      workspace: workspaceArg,
      title: z.string().describe("Column title"),
    },
  },
  async ({ workspace, title }) => {
    try {
      const board = await addColumn(workspace, title);
      return ok(summarizeBoard(board));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_rename_column",
  {
    title: "Rename board column",
    description: "Rename a column by id.",
    inputSchema: {
      workspace: workspaceArg,
      column_id: z.string(),
      title: z.string(),
    },
  },
  async ({ workspace, column_id, title }) => {
    try {
      const board = await renameColumn(workspace, column_id, title);
      return ok(summarizeBoard(board));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "board_delete_column",
  {
    title: "Delete board column",
    description:
      "Delete a column. Cards move to another column. Cannot delete the last column.",
    inputSchema: {
      workspace: workspaceArg,
      column_id: z.string(),
    },
  },
  async ({ workspace, column_id }) => {
    try {
      const board = await deleteColumn(workspace, column_id);
      return ok(summarizeBoard(board));
    } catch (error) {
      return fail(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("workspace-board-mcp listening on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
