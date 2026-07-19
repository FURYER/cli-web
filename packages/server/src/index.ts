import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import {
  disposeAllSessions,
  loadPersistedSessions,
  setBroadcaster,
  type StreamEvent,
} from "./agent.js";
import {
  installAskQuestionHook,
  setAskQuestionBroadcaster,
} from "./ask-question.js";
import { setBoardBroadcaster } from "./board.js";
import { authenticateFromHeaders } from "./auth.js";
import {
  DEPLOY_RESTART_EXIT_CODE,
  setDeployBroadcaster,
  setDeployRestartHandler,
} from "./deploy.js";
import { loadRootEnv } from "./env.js";
import {
  APP_NAME,
  dataDir,
  hasAgentApiKey,
  isStandMode,
  migrateDataDirIfNeeded,
} from "./paths.js";
import { registerSessionRoutes } from "./sessions.js";
import { syncBuiltinConfigToUser } from "./cursor-config.js";
import { ensureDefaultMcpServers } from "./mcp.js";
import { ensureWhisperReady, stopWhisperWorker } from "./whisper.js";

const envPath = loadRootEnv();
installAskQuestionHook();

const migrated = await migrateDataDirIfNeeded().catch((err) => {
  console.error("Data dir migration failed:", err);
  return null;
});
if (migrated) console.info(migrated);

await ensureDefaultMcpServers().catch((err) => {
  console.error("Failed to seed default mcp.json:", err);
});

const loadedSessions = await loadPersistedSessions();
await syncBuiltinConfigToUser().catch((err) => {
  console.error("Failed to sync built-in rules/skills:", err);
});

// Warm local Whisper in the background (same stack as voice-to-text MCP).
if ((process.env.WHISPER_ENABLED ?? "1").trim() !== "0") {
  void ensureWhisperReady()
    .then((info) => {
      console.info(`whisper ready model=${info.model} device=${info.device}`);
    })
    .catch((err) => {
      console.warn(
        `whisper unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const webDist = join(__dirname, "../../web/dist");

type SocketClient = {
  send: (data: string) => void;
  readyState: number;
};

const clients = new Set<SocketClient>();

function broadcast(event: StreamEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

setBroadcaster(broadcast);
setAskQuestionBroadcaster(broadcast);
setBoardBroadcaster(broadcast);
setDeployBroadcaster(broadcast);

const app = Fastify({
  logger: true,
  bodyLimit: 30 * 1024 * 1024,
});

await app.register(cors, { origin: true });
await app.register(websocket);
await registerSessionRoutes(app);

app.get("/ws", { websocket: true }, (socket, request) => {
  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  const query = request.query as { token?: string };
  const token = typeof query.token === "string" ? query.token : undefined;

  const auth = authenticateFromHeaders({ authorization, token });
  if ("error" in auth) {
    socket.send(JSON.stringify({ type: "error", sessionId: "", message: auth.error }));
    socket.close();
    return;
  }

  clients.add(socket);
  socket.send(JSON.stringify({ type: "status", sessionId: "", status: "connected" }));

  // Keepalive: CloudPub / reverse proxies often drop idle WS (Invalid frame header).
  const pingInterval = setInterval(() => {
    if (socket.readyState !== 1) return;
    try {
      socket.ping();
      socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
    } catch {
      /* ignore */
    }
  }, 20_000);

  socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const text = Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw).toString("utf8");
      const data = JSON.parse(text) as { type?: string; t?: number };
      if (data.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", t: data.t ?? Date.now() }));
        return;
      }
      if (data.type === "pong") return;
    } catch {
      /* ignore */
    }
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
    clients.delete(socket);
  });

  socket.on("error", () => {
    clearInterval(pingInterval);
    clients.delete(socket);
  });
});

if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}

const shutdown = async (exitCode = 0) => {
  await stopWhisperWorker().catch(() => undefined);
  await disposeAllSessions();
  await app.close();
  process.exit(exitCode);
};

setDeployRestartHandler(() => {
  void shutdown(DEPLOY_RESTART_EXIT_CODE);
});

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const isStand = isStandMode();

await app.listen({ port, host: "0.0.0.0" });
app.log.info(
  `${APP_NAME}${isStand ? " [STAND]" : ""} listening on http://127.0.0.1:${port}`,
);
app.log.info(`data dir: ${dataDir()}`);
app.log.info(`restored ${loadedSessions} session(s) from disk`);
if (envPath) {
  app.log.info(`loaded env from ${envPath}`);
} else {
  app.log.warn("no .env found at repo root — set AGENT_API_KEY and ACCESS_TOKEN");
}
if (!process.env.ACCESS_TOKEN?.trim()) {
  app.log.warn("ACCESS_TOKEN is empty — API auth will fail until you set it in .env");
}
if (!hasAgentApiKey()) {
  app.log.warn("AGENT_API_KEY is empty — agent runs will fail until you set it in .env");
}
