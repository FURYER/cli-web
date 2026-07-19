import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type WorkerReady = {
  model: string;
  device: string;
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

type WhisperStatus = {
  enabled: boolean;
  ready: boolean;
  starting: boolean;
  model: string | null;
  device: string | null;
  error: string | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../scripts/whisper_worker.py");

let child: ChildProcessWithoutNullStreams | null = null;
let stdoutBuf = "";
let readyInfo: WorkerReady | null = null;
let startPromise: Promise<WorkerReady> | null = null;
let lastError: string | null = null;
let seq = 0;
const pending = new Map<string, Pending>();
let chain: Promise<unknown> = Promise.resolve();

function enabled(): boolean {
  const raw = (process.env.WHISPER_ENABLED ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function pythonBin(): string {
  return (process.env.WHISPER_PYTHON || process.env.PYTHON || "python").trim() || "python";
}

function modelName(): string {
  return (process.env.WHISPER_MODEL || "large-v3").trim() || "large-v3";
}

function defaultLanguage(): string | null {
  const lang = (process.env.WHISPER_LANGUAGE || "ru").trim();
  if (!lang || lang === "auto" || lang === "detect") return null;
  return lang;
}

function extensionForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

function handleLine(line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (msg.event === "ready" && msg.ok === true) {
    readyInfo = {
      model: String(msg.model || modelName()),
      device: String(msg.device || "unknown"),
    };
    lastError = null;
    return;
  }

  if (msg.fatal === true) {
    lastError = String(msg.error || "Whisper worker failed to start");
    return;
  }

  const id = typeof msg.id === "string" ? msg.id : null;
  if (!id) return;
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if (msg.ok === false) {
    waiter.reject(new Error(String(msg.error || "Whisper error")));
    return;
  }
  waiter.resolve(msg);
}

function attachChild(proc: ChildProcessWithoutNullStreams): void {
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    while (true) {
      const nl = stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });

  proc.stderr.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text) console.error(`[whisper] ${text}`);
  });

  proc.on("exit", (code, signal) => {
    const err = new Error(
      `Whisper worker exited (code=${code ?? "?"}, signal=${signal ?? "none"})`,
    );
    lastError = err.message;
    readyInfo = null;
    child = null;
    startPromise = null;
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
  });
}

function send(cmd: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!child?.stdin.writable) {
    return Promise.reject(new Error("Whisper worker is not running"));
  }
  seq += 1;
  const id = `${seq}-${randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({ id, cmd, ...extra });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      child!.stdin.write(`${payload}\n`);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function waitUntilReady(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<WorkerReady> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (readyInfo) return readyInfo;
    if (lastError && !proc.killed) {
      // fatal startup reply may arrive before exit
      if (!child) throw new Error(lastError);
    }
    if (!child) throw new Error(lastError || "Whisper worker exited while starting");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for Whisper model to load");
}

export async function ensureWhisperReady(): Promise<WorkerReady> {
  if (!enabled()) {
    throw new Error("Local Whisper is disabled (WHISPER_ENABLED=0)");
  }
  if (readyInfo && child) return readyInfo;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    lastError = null;
    readyInfo = null;
    stdoutBuf = "";

    const proc = spawn(pythonBin(), ["-X", "utf8", SCRIPT], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        WHISPER_MODEL: modelName(),
        WHISPER_LANGUAGE: process.env.WHISPER_LANGUAGE || "ru",
        WHISPER_DEVICE: process.env.WHISPER_DEVICE || "auto",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = proc;
    attachChild(proc);

    const timeoutMs = Number(process.env.WHISPER_START_TIMEOUT_MS || 180_000);
    return waitUntilReady(proc, Number.isFinite(timeoutMs) ? timeoutMs : 180_000);
  })().catch((err) => {
    startPromise = null;
    throw err;
  });

  return startPromise;
}

export function getWhisperStatus(): WhisperStatus {
  return {
    enabled: enabled(),
    ready: Boolean(readyInfo && child),
    starting: Boolean(startPromise && !readyInfo),
    model: readyInfo?.model ?? (enabled() ? modelName() : null),
    device: readyInfo?.device ?? null,
    error: lastError,
  };
}

export async function transcribeAudioBuffer(
  buffer: Buffer,
  mimeType: string,
  language?: string | null,
): Promise<{ transcription: string; language?: string | null }> {
  if (!buffer.length) {
    throw new Error("Empty audio");
  }
  const maxBytes = Number(process.env.WHISPER_MAX_BYTES || 25 * 1024 * 1024);
  if (buffer.length > maxBytes) {
    throw new Error(`Audio too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`);
  }

  await ensureWhisperReady();

  const dir = join(tmpdir(), "webcli-whisper");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${Date.now()}-${randomUUID()}.${extensionForMime(mimeType)}`);
  await writeFile(filePath, buffer);

  const run = async () => {
    try {
      const lang =
        language === undefined ? defaultLanguage() : language === "" || language === "auto" ? null : language;
      const result = await send("transcribe", {
        path: filePath,
        language: lang,
      });
      return {
        transcription: String(result.transcription || "").trim(),
        language: (result.language as string | null | undefined) ?? lang,
      };
    } finally {
      await unlink(filePath).catch(() => undefined);
    }
  };

  // Serialize jobs — one GPU model, one file at a time.
  const job = chain.then(run, run);
  chain = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

export async function stopWhisperWorker(): Promise<void> {
  if (!child) return;
  try {
    await send("shutdown").catch(() => undefined);
  } catch {
    /* ignore */
  }
  const proc = child;
  child = null;
  readyInfo = null;
  startPromise = null;
  if (!proc.killed) {
    proc.kill();
  }
}
