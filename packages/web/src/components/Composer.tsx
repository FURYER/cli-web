import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Image,
  Mic,
  MicOff,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import type { AuthMode, ContextSnapshot, ModelOption, SendImagePayload, TokenUsage } from "../lib/api";
import { transcribeAudio } from "../lib/api";
import { ContextRing } from "./ContextRing";
import { FloatingMenu } from "./FloatingMenu";
import { FolderBrowser } from "./FolderBrowser";
import { iconProps } from "./icons";
import { VoiceWaveform } from "./VoiceWaveform";

type Props = {
  auth: AuthMode;
  workspace?: string;
  sessionId?: string | null;
  disabled?: boolean;
  busy?: boolean;
  model: string;
  models: ModelOption[];
  modelsLoading?: boolean;
  mode: "agent" | "plan";
  draftText?: string;
  draftKey?: number;
  lastUsage?: TokenUsage | null;
  lastContext?: ContextSnapshot | null;
  onModelChange: (modelId: string) => void;
  onModeChange: (mode: "agent" | "plan") => void;
  onSend: (text: string, images: SendImagePayload[]) => void | Promise<void>;
  onStop?: () => void;
};

const MAX_IMAGES = 12;
const DRAFT_KEY_PREFIX = "webcli.composerDraft.";

function draftStorageKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

function loadDraft(sessionId: string | null | undefined): string {
  if (!sessionId || typeof window === "undefined") return "";
  try {
    return localStorage.getItem(draftStorageKey(sessionId)) || "";
  } catch {
    return "";
  }
}

function saveDraft(sessionId: string | null | undefined, text: string): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    const key = draftStorageKey(sessionId);
    const trimmed = text.trimEnd();
    if (!trimmed) localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    /* ignore */
  }
}

function clearDraft(sessionId: string | null | undefined): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    localStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    /* ignore */
  }
}

function isCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

function mediaRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function pickRecorderMime(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fileToPayload(file: File): Promise<SendImagePayload> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return {
    mimeType: file.type || "image/png",
    data: btoa(binary),
  };
}

function toWorkspaceRelative(workspace: string | undefined, filePath: string): string {
  if (!workspace?.trim()) return filePath;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(workspace);
  const full = norm(filePath);
  const prefix = root.toLowerCase();
  if (full.toLowerCase().startsWith(prefix + "/")) {
    return full.slice(root.length + 1);
  }
  if (full.toLowerCase() === prefix) return ".";
  return filePath;
}

/** Prefer a short label; avoid "Name (id)" when name already is the id. */
function modelLabel(item: ModelOption): string {
  const name = (item.displayName || item.id).trim();
  if (!name || name === item.id) return item.id;
  // API sometimes returns "composer-1.5 (composer-1.5)"
  const wrapped = `(${item.id})`;
  if (name.endsWith(wrapped)) {
    const stripped = name.slice(0, -wrapped.length).trim();
    return stripped || item.id;
  }
  return name;
}

function dedupeModels(models: ModelOption[], current: string): ModelOption[] {
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const out: ModelOption[] = [];
  for (const item of models) {
    const id = item.id?.trim();
    if (!id) continue;
    const idKey = id.toLowerCase();
    const labelKey = modelLabel({ ...item, id }).toLowerCase();
    if (seenIds.has(idKey) || seenLabels.has(labelKey)) continue;
    seenIds.add(idKey);
    seenLabels.add(labelKey);
    out.push({ ...item, id, displayName: item.displayName || id });
  }
  const currentId = current?.trim();
  if (currentId && !seenIds.has(currentId.toLowerCase())) {
    out.unshift({ id: currentId, displayName: currentId });
  }
  return out;
}

export function Composer({
  auth,
  workspace,
  sessionId,
  disabled,
  busy,
  model,
  models,
  modelsLoading,
  mode,
  draftText,
  draftKey,
  lastUsage,
  lastContext,
  onModelChange,
  onModeChange,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ preview: string; payload: SendImagePayload }[]>([]);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSupported] = useState(() => mediaRecorderSupported());
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const voiceSessionRef = useRef(0);
  const draftSessionRef = useRef<string | null>(null);
  const textRef = useRef("");

  const modelOptions = dedupeModels(models, model);
  const selectedModel = modelOptions.find((m) => m.id === model) ?? modelOptions[0];

  // Load persisted draft when switching chats (external draftText wins).
  useEffect(() => {
    const id = sessionId ?? null;
    draftSessionRef.current = id;
    if (draftText) {
      setText(draftText);
      textRef.current = draftText;
      saveDraft(id, draftText);
      return;
    }
    const stored = loadDraft(id);
    setText(stored);
    textRef.current = stored;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Parent injects (restore, board insert, send-error). draftKey re-applies same text.
  useEffect(() => {
    if (!draftText) return;
    setText(draftText);
    textRef.current = draftText;
    saveDraft(sessionId, draftText);
  }, [draftText, draftKey, sessionId]);

  useEffect(() => {
    if (draftSessionRef.current !== (sessionId ?? null)) return;
    textRef.current = text;
    saveDraft(sessionId, text);
  }, [text, sessionId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || listening) return;
    el.style.height = "0px";
    // ~2 lines base → grow up to ~5 lines, not a tall wall of text.
    const next = Math.min(Math.max(el.scrollHeight, 44), 120);
    el.style.height = `${next}px`;
  }, [text, listening, transcribing]);

  useEffect(() => {
    return () => {
      voiceSessionRef.current += 1;
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
    };
  }, []);

  const cleanupStream = () => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setVoiceStream(null);
  };

  const stopRecording = async (opts?: { discard?: boolean }) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setListening(false);
      cleanupStream();
      return;
    }

    const session = voiceSessionRef.current;
    // Drop waveform first so AnalyserNode disconnects before tracks stop.
    setListening(false);

    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const parts = chunksRef.current;
        chunksRef.current = [];
        if (!parts.length) {
          resolve(null);
          return;
        }
        resolve(new Blob(parts, { type: recorder.mimeType || "audio/webm" }));
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });

    cleanupStream();

    if (opts?.discard || session !== voiceSessionRef.current) return;
    if (!blob || blob.size < 256) {
      setVoiceError("Recording too short — hold the mic a bit longer");
      return;
    }

    setTranscribing(true);
    setVoiceError(null);
    try {
      const audio = await blobToBase64(blob);
      const result = await transcribeAudio(auth, {
        audio,
        mimeType: blob.type || "audio/webm",
      });
      if (session !== voiceSessionRef.current) return;
      const piece = result.transcription.trim();
      if (!piece) {
        setVoiceError("No speech detected");
        return;
      }
      setText((prev) => {
        const base = prev.trimEnd();
        return base ? `${base} ${piece}` : piece;
      });
      queueMicrotask(() => textareaRef.current?.focus());
    } catch (err) {
      if (session !== voiceSessionRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setVoiceError(message);
    } finally {
      if (session === voiceSessionRef.current) setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!voiceSupported) {
      setVoiceError("Microphone recording is not supported in this browser");
      return;
    }
    if (!window.isSecureContext) {
      setVoiceError("Voice needs HTTPS — open the CloudPub URL or localhost");
      return;
    }

    setVoiceError(null);
    voiceSessionRef.current += 1;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;
      setVoiceStream(stream);
      chunksRef.current = [];

      const mimeType = pickRecorderMime();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onerror = () => {
        setVoiceError("Recording failed");
        setListening(false);
        cleanupStream();
      };

      recorder.start(250);
      setListening(true);
      queueMicrotask(() => textareaRef.current?.focus());
    } catch {
      cleanupStream();
      setListening(false);
      setVoiceError("Microphone permission denied");
    }
  };

  const toggleVoice = () => {
    if (transcribing) return;
    if (listening) void stopRecording();
    else void startRecording();
  };

  const insertFileRef = (filePath: string) => {
    const relative = toWorkspaceRelative(workspace, filePath);
    const token = `\`${relative}\``;
    setText((prev) => {
      const base = prev.trimEnd();
      return base ? `${base} ${token}` : token;
    });
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const submit = () => {
    if (listening) void stopRecording({ discard: true });
    const value = text.trim();
    // Allow send while busy — server queues behind the current run (wake race).
    if ((!value && images.length === 0) || disabled || transcribing) return;
    const payloadImages = images.map((item) => item.payload);
    const pendingText = value;
    void (async () => {
      try {
        await Promise.resolve(onSend(pendingText, payloadImages));
        clearDraft(sessionId);
        setText("");
        setImages([]);
      } catch {
        /* parent restores draft / shows error */
      }
    })();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const next: { preview: string; payload: SendImagePayload }[] = [];
    for (const file of [...files]) {
      if (!file.type.startsWith("image/")) continue;
      const payload = await fileToPayload(file);
      next.push({
        preview: `data:${payload.mimeType};base64,${payload.data}`,
        payload,
      });
    }
    if (next.length) setImages((prev) => [...prev, ...next].slice(0, MAX_IMAGES));
  };

  const canSend = Boolean(text.trim() || images.length > 0);

  return (
    <div className="relative bg-gradient-to-t from-surface via-surface/95 to-surface/0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`rounded-2xl border bg-elevated/50 shadow-[0_-1px_0_rgba(255,255,255,0.03)_inset] backdrop-blur-md transition-[border-color,box-shadow] ${
            listening
              ? "border-accent/40 shadow-[0_0_0_1px_rgba(60,158,255,0.12)]"
              : "border-line/70 focus-within:border-line"
          }`}
        >
          {images.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-b border-line/50 px-3 pt-3 pb-2">
              {images.map((item, index) => (
                <div
                  key={`${item.preview.slice(0, 32)}-${index}`}
                  className="group relative"
                >
                  <img
                    src={item.preview}
                    alt=""
                    className="h-12 w-12 rounded-lg object-cover ring-1 ring-line"
                  />
                  <button
                    type="button"
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-panel text-[9px] text-muted ring-1 ring-line hover:text-ink"
                    onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Remove image"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {listening ? (
            <button
              type="button"
              onClick={() => void stopRecording()}
              className="flex w-full items-center px-3 py-3 outline-none"
              title="Tap to stop & transcribe"
              aria-label="Stop recording"
            >
              <VoiceWaveform stream={voiceStream} active={listening} className="h-5 w-full" />
            </button>
          ) : (
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={text}
                disabled={disabled || transcribing}
                rows={1}
                placeholder={
                  transcribing
                    ? "Transcribing with Whisper…"
                    : busy
                      ? "Message queued after current reply…"
                      : "Message the agent…"
                }
                className={`max-h-[7.5rem] min-h-[2.75rem] w-full resize-none overflow-y-auto bg-transparent py-3 text-sm leading-relaxed text-ink placeholder:text-muted/70 outline-none disabled:opacity-50 ${
                  text.trim() ? "pl-3.5 pr-10" : "px-3.5"
                }`}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const items = e.clipboardData?.files;
                  if (items?.length) void addFiles(items);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  // Phone: Enter inserts a newline; send with the button.
                  // Desktop: Enter sends, Shift+Enter newline, Ctrl/Cmd+Enter also sends.
                  const mobile = isCoarsePointer();
                  if (mobile) return;
                  if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
                  e.preventDefault();
                  submit();
                }}
              />
              {text.trim() && !disabled && !transcribing ? (
                <button
                  type="button"
                  onClick={() => {
                    setText("");
                    clearDraft(sessionId);
                    queueMicrotask(() => textareaRef.current?.focus());
                  }}
                  className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
                  title="Clear message"
                  aria-label="Clear message"
                >
                  <X size={14} strokeWidth={1.75} aria-hidden />
                </button>
              ) : null}
            </div>
          )}

          {voiceError ? (
            <p className="px-3.5 pb-1 text-[11px] text-red-300/90">{voiceError}</p>
          ) : transcribing ? (
            <p className="px-3.5 pb-1 text-[11px] text-muted">
              Transcribing with local Whisper…
            </p>
          ) : null}

          <div className="flex items-center gap-0.5 px-1.5 pb-1.5 pt-0.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            <div className="relative">
              <button
                ref={attachBtnRef}
                type="button"
                onClick={() => {
                  setModelOpen(false);
                  setAttachOpen((v) => !v);
                }}
                className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.04] hover:text-ink disabled:opacity-40"
                title="Attach"
                aria-label={images.length > 0 ? `Attach (${images.length})` : "Attach"}
                aria-expanded={attachOpen}
                aria-haspopup="menu"
              >
                <Paperclip {...iconProps} />
                {images.length > 0 ? (
                  <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
                ) : null}
              </button>
              <FloatingMenu
                open={attachOpen}
                anchorRef={attachBtnRef}
                onClose={() => setAttachOpen(false)}
                className="overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-xl"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={images.length >= MAX_IMAGES}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-elevated disabled:opacity-40"
                  onClick={() => {
                    setAttachOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  <Image {...iconProps} />
                  <span>Photo</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-elevated"
                  onClick={() => {
                    setAttachOpen(false);
                    setFileBrowserOpen(true);
                  }}
                >
                  <FolderOpen {...iconProps} />
                  <span>File or folder</span>
                </button>
              </FloatingMenu>
            </div>

            <div
              className="ml-0.5 flex h-7 items-center rounded-lg bg-white/[0.03] p-0.5"
              role="group"
              aria-label="Mode"
            >
              {(["agent", "plan"] as const).map((value) => {
                const active = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onModeChange(value)}
                    className={`rounded-md px-2 py-1 text-[11px] capitalize transition-colors disabled:opacity-40 ${
                      active
                        ? "bg-elevated text-ink"
                        : "text-muted hover:text-ink"
                    }`}
                    aria-pressed={active}
                  >
                    {value}
                  </button>
                );
              })}
            </div>

            <div className="relative min-w-0 max-w-[9.5rem] sm:max-w-[12rem]">
              <button
                ref={modelBtnRef}
                type="button"
                id="model-select"
                disabled={modelsLoading || modelOptions.length === 0}
                onClick={() => {
                  setAttachOpen(false);
                  setModelOpen((v) => !v);
                }}
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                className="flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg px-2 text-[11px] text-muted transition-colors hover:bg-white/[0.04] hover:text-ink disabled:opacity-40"
              >
                <span className="min-w-0 truncate">
                  {selectedModel
                    ? modelLabel(selectedModel)
                    : modelsLoading
                      ? "…"
                      : "—"}
                </span>
                <ChevronDown size={12} strokeWidth={1.75} className="shrink-0 opacity-60" />
              </button>
              <FloatingMenu
                open={modelOpen}
                anchorRef={modelBtnRef}
                onClose={() => setModelOpen(false)}
                className="max-h-56 min-w-[12rem] overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-xl"
              >
                <ul role="listbox" aria-labelledby="model-select">
                  {modelOptions.map((item) => {
                    const selected = item.id === (selectedModel?.id ?? model);
                    return (
                      <li key={item.id} role="option" aria-selected={selected}>
                        <button
                          type="button"
                          className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-elevated ${
                            selected ? "text-ink" : "text-muted hover:text-ink"
                          }`}
                          onClick={() => {
                            onModelChange(item.id);
                            setModelOpen(false);
                          }}
                        >
                          <span className="min-w-0 truncate">{modelLabel(item)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </FloatingMenu>
            </div>

            <div className="ml-auto flex items-center gap-0.5">
              <ContextRing usage={lastUsage} context={lastContext} />

              <button
                type="button"
                disabled={disabled || !voiceSupported || transcribing}
                onClick={toggleVoice}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
                  listening
                    ? "bg-red-500/15 text-red-300"
                    : "text-muted hover:bg-white/[0.04] hover:text-ink"
                }`}
                title={
                  !voiceSupported
                    ? "Voice input not supported in this browser"
                    : transcribing
                      ? "Transcribing…"
                      : listening
                        ? "Stop & transcribe (local Whisper)"
                        : busy
                          ? "Record voice (queues after current reply)"
                          : "Record voice (local Whisper)"
                }
                aria-label={
                  transcribing
                    ? "Transcribing"
                    : listening
                      ? "Stop recording"
                      : "Voice input"
                }
                aria-pressed={listening}
              >
                {listening ? <MicOff {...iconProps} /> : <Mic {...iconProps} />}
              </button>
              {!listening ? (
                <button
                  type="button"
                  disabled={disabled || transcribing || !canSend}
                  onClick={submit}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-[var(--color-accent-ink)] transition-opacity disabled:opacity-35"
                  title={busy ? "Queue message" : "Send"}
                  aria-label={busy ? "Queue message" : "Send"}
                >
                  <Send size={14} strokeWidth={1.75} aria-hidden />
                </button>
              ) : null}
              {busy ? (
                <button
                  type="button"
                  onClick={() => onStop?.()}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/15 text-red-300 transition-colors hover:bg-red-500/25"
                  title="Stop"
                  aria-label="Stop"
                >
                  <Square size={14} strokeWidth={1.75} className="fill-current" aria-hidden />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <FolderBrowser
        auth={auth}
        mode="path"
        open={fileBrowserOpen}
        initialPath={workspace || undefined}
        onClose={() => setFileBrowserOpen(false)}
        onSelect={insertFileRef}
      />
    </div>
  );
}
