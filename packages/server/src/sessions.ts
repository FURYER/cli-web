import { authenticateRequest } from "./auth.js";
import {
  cancelSessionRun,
  createSession,
  deleteSession,
  getSession,
  getSessionConversation,
  getSessionContext,
  listCursorAgents,
  listSessions,
  listProjects,
  listProjectSessions,
  resumeSession,
  rollbackToMessage,
  sliceMessagesPage,
  submitAskQuestionAnswer,
  updateSession,
  type AskQuestionAnswer,
  type AskQuestionHandlerResult,
  type SendImageInput,
  type SessionSummary,
} from "./agent.js";
import {
  beginAskSession,
  listPendingAskQuestions,
  parseAskQuestionArgs,
  startUserQuestions,
  waitForUserQuestions,
} from "./ask-question.js";
import { listDirectory } from "./fs.js";
import {
  contentDispositionAttachment,
  isPathInsideRoot,
  mediaMimeType,
  openMediaStream,
  resolveSessionMedia,
} from "./media.js";
import {
  listRules,
  listSkills,
  readConfigDoc,
} from "./cursor-config.js";
import {
  readMcpServers,
  saveMcpServers,
  type McpServersMap,
} from "./mcp.js";
import { listModels } from "./models.js";
import { boardFilesDir, hasAgentApiKey, isStandMode } from "./paths.js";
import {
  getVapidPublicKey,
  removePushSubscription,
  savePushSubscription,
  type PushSubscriptionJSON,
} from "./push.js";
import {
  cancelDeploy,
  getDeployStatus,
  scheduleDeploy,
} from "./deploy.js";
import {
  addCard,
  addCardAttachment,
  addColumn,
  deleteCard,
  deleteColumn,
  getCardAttachment,
  loadBoard,
  moveCard,
  patchCard,
  patchColumn,
  putBoard,
  removeCardAttachment,
  type Board,
} from "./board.js";
import { getWhisperStatus, transcribeAudioBuffer } from "./whisper.js";
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url === "/api/health") return;
    const auth = await authenticateRequest(request, reply);
    if (!auth) {
      return reply;
    }
    (request as { auth?: unknown }).auth = auth;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "webcli",
    name: "WebCLI",
    stand: isStandMode(),
    port: Number(process.env.PORT || 8787),
    hasApiKey: hasAgentApiKey(),
    whisper: getWhisperStatus(),
    deploy: getDeployStatus(),
  }));

  app.get("/api/admin/deploy", async () => getDeployStatus());

  app.post<{
    Body: { delayMinutes?: number; delaySeconds?: number };
  }>("/api/admin/deploy", async (request) => {
    return scheduleDeploy({
      delayMinutes: request.body?.delayMinutes,
      delaySeconds: request.body?.delaySeconds,
    });
  });

  app.post("/api/admin/deploy/cancel", async () => cancelDeploy());

  app.get("/api/transcribe/status", async () => getWhisperStatus());

  app.post<{
    Body: { audio?: string; mimeType?: string; language?: string | null };
  }>("/api/transcribe", async (request, reply) => {
    try {
      const audio = request.body?.audio;
      const mimeType = request.body?.mimeType || "audio/webm";
      if (!audio || typeof audio !== "string") {
        return reply.code(400).send({ error: "audio (base64) is required" });
      }
      const buffer = Buffer.from(audio, "base64");
      if (!buffer.length) {
        return reply.code(400).send({ error: "invalid audio payload" });
      }
      const result = await transcribeAudioBuffer(
        buffer,
        mimeType,
        request.body?.language,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/fs", async (request, reply) => {
    try {
      const query = request.query as { path?: string; files?: string };
      return await listDirectory(query.path, {
        includeFiles: query.files === "1" || query.files === "true",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/models", async (_request, reply) => {
    try {
      return await listModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/mcp", async () => ({
    // Raw file (keeps ${CONTEXT7_API_KEY} placeholders for Settings UI).
    servers: await readMcpServers(),
  }));

  app.put<{ Body: { servers?: McpServersMap } }>("/api/mcp", async (request, reply) => {
    try {
      const servers = request.body?.servers ?? {};
      await saveMcpServers(servers);
      return { ok: true, servers };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/agents", async (request, reply) => {
    try {
      const workspace = (request.query as { workspace?: string }).workspace;
      const items = await listCursorAgents(workspace);
      return { items };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/config/rules", async (request) => {
    const workspace = (request.query as { workspace?: string }).workspace;
    return { items: await listRules(workspace) };
  });

  app.get("/api/config/skills", async (request) => {
    const workspace = (request.query as { workspace?: string }).workspace;
    return { items: await listSkills(workspace) };
  });

  app.get("/api/config/doc", async (request, reply) => {
    try {
      const query = request.query as { path?: string; workspace?: string };
      if (!query.path?.trim()) {
        return reply.code(400).send({ error: "path is required" });
      }
      return await readConfigDoc(query.path, query.workspace);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/push/vapid-public-key", async () => ({
    publicKey: await getVapidPublicKey(),
  }));

  app.post<{ Body: PushSubscriptionJSON }>("/api/push/subscribe", async (request, reply) => {
    try {
      await savePushSubscription(request.body);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Body: { endpoint?: string } }>("/api/push/unsubscribe", async (request, reply) => {
    const endpoint = request.body?.endpoint?.trim();
    if (!endpoint) {
      return reply.code(400).send({ error: "endpoint is required" });
    }
    await removePushSubscription(endpoint);
    return { ok: true };
  });

  app.get<{ Reply: SessionSummary[] }>("/api/sessions", async () => listSessions());

  app.get<{
    Querystring: {
      limit?: string;
      beforeUpdatedAt?: string;
      sessionsLimit?: string;
    };
  }>("/api/projects", async (request) => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    const beforeUpdatedAt = request.query.beforeUpdatedAt
      ? Number(request.query.beforeUpdatedAt)
      : undefined;
    const sessionsLimit = request.query.sessionsLimit
      ? Number(request.query.sessionsLimit)
      : undefined;
    return listProjects({
      limit: Number.isFinite(limit) ? limit : undefined,
      beforeUpdatedAt: Number.isFinite(beforeUpdatedAt) ? beforeUpdatedAt : undefined,
      sessionsLimit: Number.isFinite(sessionsLimit) ? sessionsLimit : undefined,
    });
  });

  app.get<{
    Querystring: {
      workspace?: string;
      limit?: string;
      beforeUpdatedAt?: string;
    };
  }>("/api/projects/sessions", async (request, reply) => {
    const workspace = request.query.workspace?.trim();
    if (!workspace) {
      return reply.code(400).send({ error: "workspace is required" });
    }
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    const beforeUpdatedAt = request.query.beforeUpdatedAt
      ? Number(request.query.beforeUpdatedAt)
      : undefined;
    return listProjectSessions({
      workspace,
      limit: Number.isFinite(limit) ? limit : undefined,
      beforeUpdatedAt: Number.isFinite(beforeUpdatedAt) ? beforeUpdatedAt : undefined,
    });
  });

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before?: string };
  }>("/api/sessions/:id", async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }
    const limitRaw = request.query.limit ? Number(request.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const before = request.query.before?.trim() || undefined;
    const page = sliceMessagesPage(session.messages, { limit, before });
    const { usage, context } = await getSessionContext(session.id);
    return {
      id: session.id,
      agentId: session.agentId,
      workspace: session.workspace,
      model: session.model,
      mode: session.mode || "agent",
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: page.messageCount,
      busy: Boolean(session.busy),
      messages: page.messages,
      hasMoreOlder: page.hasMoreOlder,
      usage: usage ?? undefined,
      context: context ?? undefined,
    };
  });

  app.get<{
    Params: { id: string };
    Querystring: { path?: string; token?: string; download?: string };
  }>(
    "/api/sessions/:id/media",
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }
      const rawPath = request.query.path?.trim();
      if (!rawPath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const forceDownload =
        request.query.download === "1" || request.query.download === "true";
      try {
        const media = await resolveSessionMedia(
          session.id,
          session.workspace,
          rawPath,
        );
        const size = media.size;
        reply.header("Accept-Ranges", "bytes");
        reply.header("Cache-Control", "private, max-age=3600");
        reply.header("Content-Type", media.mimeType);

        if (forceDownload || media.kind === "file") {
          reply.header(
            "Content-Disposition",
            contentDispositionAttachment(media.absolute),
          );
        }

        const range = request.headers.range;
        if (range && media.kind === "video" && !forceDownload) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match) {
            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Number(match[2]) : size - 1;
            if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
              const clampedEnd = Math.min(end, size - 1);
              reply.code(206);
              reply.header("Content-Range", `bytes ${start}-${clampedEnd}/${size}`);
              reply.header("Content-Length", String(clampedEnd - start + 1));
              return reply.send(openMediaStream(media.absolute, start, clampedEnd));
            }
          }
        }

        reply.header("Content-Length", String(size));
        return reply.send(openMediaStream(media.absolute));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notFound = /not found|outside/i.test(message);
        return reply.code(notFound ? 404 : 400).send({ error: message });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/conversation",
    async (request, reply) => {
      try {
        const conversation = await getSessionConversation(request.params.id);
        return { conversation };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.post<{
    Body: { workspace?: string; model?: string; title?: string; mode?: string };
  }>("/api/sessions", async (request, reply) => {
    const workspace =
      request.body?.workspace?.trim() ||
      process.env.DEFAULT_WORKSPACE?.trim() ||
      process.cwd();
    try {
      const session = await createSession({
        workspace,
        model: request.body?.model,
        title: request.body?.title,
        mode: request.body?.mode === "plan" ? "plan" : "agent",
      });
      return reply.code(201).send(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      agentId?: string;
      workspace?: string;
      model?: string;
      title?: string;
      mode?: string;
    };
  }>("/api/sessions/:id/resume", async (request, reply) => {
    const agentId = request.body?.agentId?.trim() || request.params.id;
    const workspace =
      request.body?.workspace?.trim() ||
      process.env.DEFAULT_WORKSPACE?.trim() ||
      process.cwd();
    try {
      const session = await resumeSession({
        agentId,
        workspace,
        model: request.body?.model,
        title: request.body?.title,
        mode: request.body?.mode === "plan" ? "plan" : "agent",
      });
      return reply.code(201).send(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { mode?: string; title?: string };
  }>("/api/sessions/:id", async (request, reply) => {
    try {
      const patch: { mode?: "agent" | "plan"; title?: string } = {};
      if (request.body?.mode === "plan" || request.body?.mode === "agent") {
        patch.mode = request.body.mode;
      }
      if (typeof request.body?.title === "string") {
        patch.title = request.body.title;
      }
      if (!patch.mode && patch.title === undefined) {
        return reply.code(400).send({ error: "Provide mode and/or title" });
      }
      return await updateSession(request.params.id, patch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      text?: string;
      model?: string;
      mode?: string;
      images?: SendImageInput[];
      clientMessageId?: string;
    };
  }>("/api/sessions/:id/messages", async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }
    const text = request.body?.text ?? "";
    const images = request.body?.images ?? [];
    if (!text.trim() && images.length === 0) {
      return reply.code(400).send({ error: "Message text is required" });
    }
    try {
      const { enqueueSessionSend } = await import("./agent.js");
      const result = enqueueSessionSend(
        request.params.id,
        text,
        {
          modelId: request.body?.model,
          mode: request.body?.mode === "plan" ? "plan" : "agent",
          images,
          clientMessageId: request.body?.clientMessageId,
        },
        "user",
      );
      return reply.code(202).send({
        accepted: true,
        queued: result.queued,
        sessionId: request.params.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{
    Params: { id: string };
    Body: { clientMessageId?: string; content?: string };
  }>("/api/sessions/:id/messages/queue", async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }
    try {
      const { cancelQueuedSend } = await import("./agent.js");
      const result = cancelQueuedSend(request.params.id, {
        clientMessageId: request.body?.clientMessageId,
        content: request.body?.content,
      });
      if (!result.ok) {
        return reply.code(404).send({ error: result.reason });
      }
      return { ok: true, clientMessageId: result.clientMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/cancel",
    async (request, reply) => {
      try {
        await cancelSessionRun(request.params.id);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/ask-questions",
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      return { pending: listPendingAskQuestions(request.params.id) };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      title?: string;
      questions?: unknown;
    };
  }>("/api/sessions/:id/questions", async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const args = parseAskQuestionArgs({
      title: request.body?.title,
      questions: request.body?.questions,
    });
    if (!args) {
      return reply.code(400).send({ error: "Invalid questions payload" });
    }
    beginAskSession(request.params.id);
    const { callId } = startUserQuestions(request.params.id, args);
    return { callId };
  });

  app.get<{
    Params: { id: string; callId: string };
    Querystring: { timeoutMs?: string };
  }>("/api/sessions/:id/questions/:callId/wait", async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const timeoutRaw = Number(request.query.timeoutMs);
    const timeoutMs =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.min(timeoutRaw, 15 * 60 * 1000)
        : 10 * 60 * 1000;
    try {
      const result = await waitForUserQuestions(
        request.params.id,
        request.params.callId,
        timeoutMs,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /not found/i.test(message)
        ? 404
        : /belong/i.test(message)
          ? 403
          : /timed out/i.test(message)
            ? 408
            : 400;
      return reply.code(code).send({ error: message });
    }
  });

  app.post<{
    Params: { id: string; callId: string };
    Body: {
      outcome?: string;
      answers?: AskQuestionAnswer[];
      reason?: string;
    };
  }>("/api/sessions/:id/ask-questions/:callId/answer", async (request, reply) => {
    try {
      const outcome = request.body?.outcome === "skipped" ? "skipped" : "answered";
      const result: AskQuestionHandlerResult =
        outcome === "answered"
          ? {
              outcome: "answered",
              answers: Array.isArray(request.body?.answers)
                ? request.body.answers
                : [],
            }
          : {
              outcome: "skipped",
              reason: request.body?.reason?.trim() || "Questions skipped by the user",
            };
      if (result.outcome === "answered" && result.answers.length === 0) {
        return reply.code(400).send({ error: "answers are required" });
      }
      const message = submitAskQuestionAnswer(
        request.params.id,
        request.params.callId,
        result,
      );
      return { ok: true, message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /not found/i.test(message)
        ? 404
        : /belong/i.test(message)
          ? 403
          : 400;
      return reply.code(code).send({ error: message });
    }
  });

  app.post<{
    Params: { id: string; messageId: string };
  }>("/api/sessions/:id/messages/:messageId/rollback", async (request, reply) => {
    try {
      const result = await rollbackToMessage(request.params.id, request.params.messageId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes("not found")
        ? 404
        : message.includes("running")
          ? 409
          : 400;
      return reply.code(code).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const ok = await deleteSession(request.params.id);
    if (!ok) return reply.code(404).send({ error: "Session not found" });
    return { ok: true };
  });

  // —— Task board (workspace-scoped kanban) ——

  function boardError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /not found/i.test(message)
      ? 404
      : /required|Cannot delete/i.test(message)
        ? 400
        : 500;
    return reply.code(code).send({ error: message });
  }

  app.get<{ Querystring: { workspace?: string } }>("/api/board", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await loadBoard(workspace);
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.put<{
    Querystring: { workspace?: string };
    Body: Board;
  }>("/api/board", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await putBoard(workspace, request.body);
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.post<{
    Querystring: { workspace?: string };
    Body: { title?: string };
  }>("/api/board/columns", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await addColumn(workspace, request.body?.title ?? "Column");
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.patch<{
    Params: { id: string };
    Querystring: { workspace?: string };
    Body: { title?: string; order?: number };
  }>("/api/board/columns/:id", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await patchColumn(workspace, request.params.id, request.body ?? {});
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.delete<{
    Params: { id: string };
    Querystring: { workspace?: string };
  }>("/api/board/columns/:id", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await deleteColumn(workspace, request.params.id);
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.post<{
    Querystring: { workspace?: string };
    Body: { title?: string; body?: string; columnId?: string };
  }>("/api/board/cards", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await addCard(workspace, {
        title: request.body?.title ?? "",
        body: request.body?.body,
        columnId: request.body?.columnId,
      });
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.patch<{
    Params: { id: string };
    Querystring: { workspace?: string };
    Body: { title?: string; body?: string; columnId?: string; order?: number };
  }>("/api/board/cards/:id", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await patchCard(workspace, request.params.id, request.body ?? {});
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { workspace?: string };
    Body: { columnId?: string; order?: number };
  }>("/api/board/cards/:id/move", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    const columnId = request.body?.columnId?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    if (!columnId) return reply.code(400).send({ error: "columnId is required" });
    try {
      return await moveCard(workspace, request.params.id, {
        columnId,
        order: request.body?.order,
      });
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.delete<{
    Params: { id: string };
    Querystring: { workspace?: string };
  }>("/api/board/cards/:id", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await deleteCard(workspace, request.params.id);
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { workspace?: string };
    Body: { name?: string; mimeType?: string; data?: string };
  }>("/api/board/cards/:id/attachments", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    const name = request.body?.name?.trim() || "file";
    const mimeType = request.body?.mimeType?.trim() || "application/octet-stream";
    const data = request.body?.data;
    if (!data || typeof data !== "string") {
      return reply.code(400).send({ error: "data (base64) is required" });
    }
    try {
      return await addCardAttachment(workspace, request.params.id, {
        name,
        mimeType,
        data,
      });
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.get<{
    Params: { id: string; attId: string };
    Querystring: { workspace?: string; download?: string; token?: string };
  }>("/api/board/cards/:id/attachments/:attId", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      const board = await loadBoard(workspace);
      const att = getCardAttachment(board, request.params.id, request.params.attId);
      if (!existsSync(att.path) || !isPathInsideRoot(boardFilesDir(workspace), att.path)) {
        return reply.code(404).send({ error: "Attachment file missing" });
      }
      const download = request.query.download === "1" || request.query.download === "true";
      const mime = att.mimeType || mediaMimeType(att.path);
      void reply.header("Content-Type", mime);
      if (download || !mime.startsWith("image/")) {
        void reply.header(
          "Content-Disposition",
          contentDispositionAttachment(att.name || basename(att.path)),
        );
      }
      return reply.send(createReadStream(att.path));
    } catch (err) {
      return boardError(reply, err);
    }
  });

  app.delete<{
    Params: { id: string; attId: string };
    Querystring: { workspace?: string };
  }>("/api/board/cards/:id/attachments/:attId", async (request, reply) => {
    const workspace = request.query.workspace?.trim() || "";
    if (!workspace) return reply.code(400).send({ error: "workspace is required" });
    try {
      return await removeCardAttachment(
        workspace,
        request.params.id,
        request.params.attId,
      );
    } catch (err) {
      return boardError(reply, err);
    }
  });
}
