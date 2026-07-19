import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  RotateCcw,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ActivityItem,
  AskQuestionAnswer,
  AskQuestionItem,
  AuthMode,
  ChatMessage,
} from "../lib/api";
import {
  extractDownloadablePathsFromText,
  extractMediaPathsFromText,
  fileBasename,
  chatUrlTransform,
  isDownloadableFilePath,
  isImageMediaPath,
  isVideoMediaPath,
  sessionMediaUrl,
} from "../lib/api";
import { formatMessageTime } from "../lib/time";
import { AskQuestionCard } from "./AskQuestionCard";
import { iconProps } from "./icons";

type LiveActivity = ActivityItem & { startedAt?: number };

export type PendingAskQuestion = {
  callId: string;
  toolCallId: string;
  title?: string;
  questions: AskQuestionItem[];
};

type Props = {
  messages: ChatMessage[];
  streamingText: string;
  activities: LiveActivity[];
  pendingQuestions?: PendingAskQuestion[];
  busy?: boolean;
  sessionId?: string | null;
  auth?: AuthMode;
  askSubmittingId?: string | null;
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void | Promise<void>;
  onRollback?: (messageId: string) => void;
  onCancelQueued?: (messageId: string) => void;
  onImplementPlan?: () => void;
  onAnswerQuestion?: (callId: string, answers: AskQuestionAnswer[]) => void;
  onSkipQuestion?: (callId: string) => void;
  /** Scroll-down hides chrome; scroll-up reveals it. */
  onScrollDirection?: (direction: "up" | "down", scrollTop: number) => void;
};

type StepItem = {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  durationMs?: number;
  startedAt?: number;
  detail?: string;
  kind?: ChatMessage["activityKind"] | "tool";
  toolName?: string;
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
  linesCreated?: number;
};

type TimelineBlock =
  | { type: "user"; key: string; message: ChatMessage }
  | { type: "assistant"; key: string; message: ChatMessage }
  | { type: "question"; key: string; message: ChatMessage }
  | {
      type: "work";
      key: string;
      steps: StepItem[];
      live: boolean;
      defaultOpen: boolean;
    };

const NEAR_BOTTOM_PX = 80;

const EXPLORE_LABEL_RE =
  /^(reading|grepping|glob|listing|searching|explored)\b/i;

function resolveMediaSrc(
  src: string | undefined,
  sessionId: string | null | undefined,
  auth: AuthMode | undefined,
): string | undefined {
  if (!src) return src;
  if (/^https?:\/\//i.test(src) || src.startsWith("data:") || src.startsWith("blob:")) {
    return src;
  }
  if (!sessionId || !auth) return src;
  if (!isImageMediaPath(src) && !isVideoMediaPath(src)) return src;
  return sessionMediaUrl(auth, sessionId, src);
}

function WorkspaceMedia({
  paths,
  sessionId,
  auth,
}: {
  paths: string[];
  sessionId: string;
  auth: AuthMode;
}) {
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {paths.map((path) => {
        const src = sessionMediaUrl(auth, sessionId, path);
        if (isVideoMediaPath(path)) {
          return (
            <SafeVideo key={path} src={src} title={path} />
          );
        }
        return (
          <OpenableImage
            key={path}
            src={src}
            alt={path}
            className="max-h-72 max-w-full rounded-md object-contain ring-1 ring-line"
          />
        );
      })}
    </div>
  );
}

function DownloadFileChip({
  path,
  label,
  sessionId,
  auth,
}: {
  path: string;
  label?: string;
  sessionId: string;
  auth: AuthMode;
}) {
  const href = sessionMediaUrl(auth, sessionId, path, { download: true });
  const fileName = fileBasename(path);
  const name = label?.trim() || fileName;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDownload = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const absHref = new URL(href, window.location.origin).href;
      const res = await fetch(absHref);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const file = new File([blob], fileName, {
        type: blob.type || "application/octet-stream",
      });

      const nav = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
        share?: (data: ShareData) => Promise<void>;
      };
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

      // Prefer system share — keeps the PWA from navigating away.
      if (typeof nav.share === "function") {
        try {
          if (typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
            await nav.share({ files: [file], title: fileName });
            return;
          }
          await nav.share({ url: absHref, title: fileName, text: fileName });
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // Fall through to other strategies.
        }
      }

      // Desktop (and some Android): anchor download with blob, no full navigation.
      if (!isMobile) {
        const objectUrl = URL.createObjectURL(blob);
        try {
          const a = document.createElement("a");
          a.href = objectUrl;
          a.download = fileName;
          a.rel = "noopener";
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);
        }
        return;
      }

      // Mobile without share: hidden iframe to Content-Disposition URL (no SPA leave).
      await new Promise<void>((resolve, reject) => {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("aria-hidden", "true");
        iframe.style.cssText =
          "position:fixed;width:0;height:0;border:0;left:0;top:0;opacity:0;pointer-events:none";
        iframe.src = absHref;
        const timer = window.setTimeout(() => {
          iframe.remove();
          resolve();
        }, 8_000);
        iframe.onerror = () => {
          window.clearTimeout(timer);
          iframe.remove();
          reject(new Error("Download failed"));
        };
        document.body.appendChild(iframe);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-1 flex max-w-full flex-col gap-1">
      <button
        type="button"
        onClick={() => void onDownload()}
        disabled={busy}
        className="inline-flex max-w-full items-center gap-2 rounded-md bg-elevated px-3 py-2 text-left text-[13px] text-fg ring-1 ring-line hover:bg-elevated/80 disabled:opacity-60"
        title={`Download ${name}`}
      >
        <Download size={16} strokeWidth={1.75} className="shrink-0 text-muted" />
        <span className="min-w-0 truncate font-medium">{name}</span>
        <span className="shrink-0 text-[11px] text-muted">
          {busy ? "…" : "Download"}
        </span>
      </button>
      {error ? (
        <span className="px-1 text-[11px] text-red-400">{error}</span>
      ) : null}
    </div>
  );
}

function WorkspaceDownloads({
  paths,
  sessionId,
  auth,
}: {
  paths: string[];
  sessionId: string;
  auth: AuthMode;
}) {
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {paths.map((path) => (
        <DownloadFileChip
          key={path}
          path={path}
          sessionId={sessionId}
          auth={auth}
        />
      ))}
    </div>
  );
}

function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-3"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image preview"}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/20 hover:bg-black/70"
        aria-label="Close image"
      >
        <X size={20} strokeWidth={1.75} />
      </button>
      <img
        src={src}
        alt={alt || ""}
        className="max-h-[min(92vh,100%)] max-w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/** Thumbnail that opens a fullscreen preview with a close control. */
function OpenableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1 inline-block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
        title="Open image"
        aria-label={alt ? `Open image: ${alt}` : "Open image"}
      >
        <SafeImage src={src} alt={alt} className={className} />
      </button>
      {open ? (
        <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function SafeImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="inline-block rounded-md bg-elevated px-2 py-1 text-[11px] text-muted ring-1 ring-line">
        {alt || "Image unavailable"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

function SafeVideo({ src, title }: { src: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="inline-block rounded-md bg-elevated px-2 py-1 text-[11px] text-muted ring-1 ring-line">
        {title || "Video unavailable"}
      </span>
    );
  }
  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      className="max-h-80 max-w-full rounded-md ring-1 ring-line"
      title={title}
      onError={() => setFailed(true)}
    />
  );
}

function MarkdownBody({
  text,
  sessionId,
  auth,
  /** Plans cite paths — don't turn them into Download chips. */
  fileLinks = "download",
}: {
  text: string;
  sessionId?: string | null;
  auth?: AuthMode;
  fileLinks?: "download" | "cite";
}) {
  const extraPaths = useMemo(() => {
    if (!sessionId || !auth) return [];
    const all = extractMediaPathsFromText(text);
    const mdSrcs = new Set(
      [...text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)].map((m) =>
        (m[1] || "").replace(/\\/g, "/").toLowerCase(),
      ),
    );
    return all.filter((p) => !mdSrcs.has(p.replace(/\\/g, "/").toLowerCase()));
  }, [text, sessionId, auth]);

  const linkedDownloadHrefs = useMemo(() => {
    const set = new Set<string>();
    for (const match of text.matchAll(/(!?)\[([^\]]*)]\(([^)\s]+)\)/g)) {
      if (match[1] === "!") continue;
      const href = (match[3] || "").replace(/\\/g, "/").toLowerCase();
      if (href) set.add(href);
    }
    return set;
  }, [text]);

  const extraDownloads = useMemo(() => {
    if (fileLinks !== "download" || !sessionId || !auth) return [];
    return extractDownloadablePathsFromText(text).filter(
      (p) => !linkedDownloadHrefs.has(p.replace(/\\/g, "/").toLowerCase()),
    );
  }, [text, sessionId, auth, linkedDownloadHrefs, fileLinks]);

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={chatUrlTransform}
        components={{
          pre: ({ children }) => <MarkdownCodeFence>{children}</MarkdownCodeFence>,
          img: ({ src, alt }) => {
            const resolved = resolveMediaSrc(src, sessionId, auth);
            if (!resolved) return null;
            if (src && isVideoMediaPath(src)) {
              return <SafeVideo key={resolved} src={resolved} title={alt || src} />;
            }
            return (
              <OpenableImage
                src={resolved}
                alt={alt || ""}
                className="max-h-72 max-w-full rounded-md object-contain ring-1 ring-line"
              />
            );
          },
          a: ({ href, children }) => {
            if (href && isDownloadableFilePath(href)) {
              const label =
                typeof children === "string"
                  ? children
                  : Array.isArray(children)
                    ? children.map(String).join("")
                    : undefined;
              if (fileLinks === "cite") {
                return (
                  <code className="rounded bg-white/[0.05] px-1 py-0.5 font-mono text-[12px] text-ink/90">
                    {label || fileBasename(href)}
                  </code>
                );
              }
              if (sessionId && auth) {
                return (
                  <DownloadFileChip
                    path={href}
                    label={label}
                    sessionId={sessionId}
                    auth={auth}
                  />
                );
              }
            }
            // Never navigate on empty/stripped hrefs (react-markdown default).
            if (!href) {
              return <span>{children}</span>;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {sessionId && auth && extraPaths.length > 0 ? (
        <WorkspaceMedia paths={extraPaths} sessionId={sessionId} auth={auth} />
      ) : null}
      {sessionId && auth && extraDownloads.length > 0 ? (
        <WorkspaceDownloads
          paths={extraDownloads}
          sessionId={sessionId}
          auth={auth}
        />
      ) : null}
    </div>
  );
}

function looksLikePlanMarkdown(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  if (!/^#\s+\S/m.test(t)) return false;
  return (
    /^##\s+/m.test(t) ||
    /\b(Todos|Решения|Фаза|Overview|Test plan)\b/i.test(t)
  );
}

function isPlanDocumentMessage(
  message: ChatMessage,
  all: ChatMessage[],
): boolean {
  if (message.toolName === "createPlan") return true;
  if (message.role !== "assistant") return false;
  if (!looksLikePlanMarkdown(message.content)) return false;
  // Fallback when an older turn streamed the plan without toolName tagging.
  return all.some(
    (m) =>
      m.toolName === "createPlan" ||
      (m.role === "activity" &&
        (m.toolName || "").replace(/[_-]/g, "").toLowerCase() === "createplan"),
  );
}

const AssistantMessage = memo(function AssistantMessage({
  text,
  sessionId,
  auth,
  isPlanDocument,
  createdAt,
  durationMs,
  onImplementPlan,
}: {
  text: string;
  sessionId?: string | null;
  auth?: AuthMode;
  /** True when this message is the CreatePlan body. */
  isPlanDocument?: boolean;
  createdAt?: number;
  durationMs?: number;
  onImplementPlan?: () => void;
}) {
  return (
    <div className="group relative w-full">
      <div
        className={
          isPlanDocument
            ? "w-full rounded-xl border border-line bg-elevated/60 px-3.5 py-3 text-sm leading-relaxed text-ink"
            : "w-full text-sm leading-relaxed text-ink"
        }
      >
        {isPlanDocument ? (
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-block rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              Plan
            </span>
            {onImplementPlan ? (
              <button
                type="button"
                onClick={onImplementPlan}
                className="shrink-0 rounded-md bg-accent/90 px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-ink)] transition-opacity hover:opacity-90"
              >
                Implement in agent
              </button>
            ) : null}
          </div>
        ) : null}
        <MarkdownBody
          text={text}
          sessionId={sessionId}
          auth={auth}
          fileLinks={isPlanDocument ? "cite" : "download"}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <MessageTimestamp createdAt={createdAt} />
        <MessageDuration durationMs={durationMs} />
        <CopyButton text={text} />
      </div>
    </div>
  );
});

function MessageTimestamp({ createdAt }: { createdAt?: number }) {
  if (!createdAt) return null;
  const label = formatMessageTime(createdAt);
  if (!label) return null;
  return (
    <time
      dateTime={new Date(createdAt).toISOString()}
      className="px-0.5 text-[11px] tabular-nums text-muted/80"
      title={new Date(createdAt).toLocaleString()}
    >
      {label}
    </time>
  );
}

function MessageDuration({
  durationMs,
  live = false,
}: {
  durationMs?: number;
  live?: boolean;
}) {
  if (typeof durationMs !== "number" || durationMs < 0 || !Number.isFinite(durationMs)) {
    return null;
  }
  const label = formatDuration(durationMs);
  return (
    <span
      className="px-0.5 text-[11px] tabular-nums text-muted/80"
      title={live ? "Elapsed" : "Response time"}
      aria-live={live ? "off" : undefined}
    >
      {label}
    </span>
  );
}

/** Prefer persisted duration; else wall-clock from preceding user turn. */
function resolveAssistantDurationMs(
  message: ChatMessage,
  messages: ChatMessage[],
): number | undefined {
  if (typeof message.durationMs === "number" && message.durationMs >= 0) {
    return message.durationMs;
  }
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx < 0) return undefined;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") {
      const ms = message.createdAt - messages[i]!.createdAt;
      return ms >= 0 ? ms : undefined;
    }
  }
  return undefined;
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText(
      (node as { props?: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

function MarkdownCodeFence({ children }: { children?: ReactNode }) {
  const text = nodeText(children).replace(/\n$/, "");
  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      <div className="absolute right-1.5 top-1.5 z-10 opacity-70 transition-opacity group-hover/code:opacity-100">
        <CopyButton
          text={text}
          ariaLabel="Copy code"
          className="inline-flex items-center gap-1 rounded-md bg-black/35 px-1.5 py-0.5 text-[11px] text-muted backdrop-blur-sm transition-colors hover:bg-white/[0.08] hover:text-ink"
        />
      </div>
    </div>
  );
}

function CopyButton({
  text,
  ariaLabel = "Copy message",
  className = "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-white/[0.04] hover:text-ink md:opacity-70 md:group-hover:opacity-100",
}: {
  text: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={className}
      title="Copy"
      aria-label={ariaLabel}
    >
      {copied ? (
        <Check size={12} strokeWidth={1.75} aria-hidden />
      ) : (
        <Copy size={12} strokeWidth={1.75} aria-hidden />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

function isPlanningPlaceholderId(id: string): boolean {
  return id === "planning" || id === "working";
}

function isActivityMessage(message: ChatMessage): boolean {
  return message.role === "activity" || message.role === "tool";
}

function isUsageStep(step: StepItem): boolean {
  return step.kind === "usage" || /^(tokens|context)\b/i.test(step.label);
}

function isExploreStep(step: StepItem): boolean {
  if (isUsageStep(step)) return false;
  if (/^think/i.test(step.label) || step.kind === "thinking") return false;
  return EXPLORE_LABEL_RE.test(step.label);
}

function messageToStep(message: ChatMessage): StepItem {
  const durationMs = message.durationMs;
  // Persist path has no live startedAt — infer from createdAt so Work stays wall-clock.
  const startedAt =
    typeof durationMs === "number" &&
    durationMs >= 0 &&
    typeof message.createdAt === "number"
      ? Math.max(0, message.createdAt - durationMs)
      : typeof message.createdAt === "number"
        ? message.createdAt
        : undefined;

  if (message.role === "tool") {
    return {
      id: message.id,
      label: message.toolName || message.content,
      status: "completed",
      durationMs,
      startedAt,
      detail: message.detail,
      kind: "tool",
      toolName: message.toolName,
      filePath: message.filePath,
      linesAdded: message.linesAdded,
      linesRemoved: message.linesRemoved,
      linesCreated: message.linesCreated,
    };
  }
  return {
    id: message.activityId || message.id,
    label: message.content,
    status: message.activityStatus || "completed",
    durationMs,
    startedAt,
    detail: message.detail,
    kind: message.activityKind,
    toolName: message.toolName,
    filePath: message.filePath,
    linesAdded: message.linesAdded,
    linesRemoved: message.linesRemoved,
    linesCreated: message.linesCreated,
  };
}

function liveToStep(item: LiveActivity): StepItem {
  return {
    id: item.id,
    label: item.label,
    status: item.status,
    durationMs: item.durationMs,
    startedAt: item.startedAt,
    detail: item.detail,
    kind: item.kind,
    toolName: item.toolName,
    filePath: item.filePath,
    linesAdded: item.linesAdded,
    linesRemoved: item.linesRemoved,
    linesCreated: item.linesCreated,
  };
}

/** Drop empty duplicate Thought rows next to a real one; hide empty running shells. */
function filterVisibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message, index) => {
    if (message.role !== "activity" || message.activityKind !== "thinking") {
      return true;
    }
    if (message.detail?.trim()) return true;
    // Empty running Thought — Chat shows "Planning next moves" instead.
    if (message.activityStatus === "running") return false;
    const prev = messages[index - 1];
    const next = messages[index + 1];
    const neighborIsThought = (other?: ChatMessage) =>
      other?.role === "activity" &&
      other.activityKind === "thinking" &&
      Boolean(other.detail?.trim());
    return !neighborIsThought(prev) && !neighborIsThought(next);
  });
}

function mergeSteps(persisted: StepItem[], live: StepItem[]): StepItem[] {
  const byId = new Map<string, StepItem>();
  const order: string[] = [];
  for (const step of persisted) {
    byId.set(step.id, step);
    order.push(step.id);
  }
  for (const step of live) {
    const prev = byId.get(step.id);
    if (prev) {
      byId.set(step.id, {
        ...prev,
        ...step,
        detail: step.detail ?? prev.detail,
        startedAt: step.startedAt ?? prev.startedAt,
        durationMs: step.durationMs ?? prev.durationMs,
        filePath: step.filePath ?? prev.filePath,
        toolName: step.toolName ?? prev.toolName,
        linesAdded: step.linesAdded ?? prev.linesAdded,
        linesRemoved: step.linesRemoved ?? prev.linesRemoved,
        linesCreated: step.linesCreated ?? prev.linesCreated,
      });
    } else {
      byId.set(step.id, step);
      order.push(step.id);
    }
  }
  return order.map((id) => byId.get(id)!);
}

function buildTimeline(
  messages: ChatMessage[],
  liveSteps: StepItem[],
  busy: boolean,
): TimelineBlock[] {
  const visible = filterVisibleMessages(messages);
  const blocks: TimelineBlock[] = [];
  let pendingSteps: StepItem[] = [];
  let workIndex = 0;

  const flushWork = (opts: { live: boolean; defaultOpen: boolean }) => {
    if (pendingSteps.length === 0 && !opts.live) return;
    const steps = opts.live ? mergeSteps(pendingSteps, liveSteps) : pendingSteps;
    if (steps.length === 0) return;
    const keySeed = steps[0]?.id ?? String(workIndex);
    blocks.push({
      type: "work",
      key: `work-${keySeed}-${workIndex++}`,
      steps,
      live: opts.live,
      defaultOpen: opts.defaultOpen,
    });
    pendingSteps = [];
  };

  for (const message of visible) {
    if (message.role === "user") {
      flushWork({ live: false, defaultOpen: false });
      blocks.push({ type: "user", key: message.id, message });
      continue;
    }
    if (message.role === "question") {
      flushWork({ live: false, defaultOpen: false });
      blocks.push({ type: "question", key: message.id, message });
      continue;
    }
    if (isActivityMessage(message)) {
      pendingSteps.push(messageToStep(message));
      continue;
    }
    flushWork({ live: false, defaultOpen: false });
    blocks.push({ type: "assistant", key: message.id, message });
  }

  if (liveSteps.length > 0 || pendingSteps.length > 0) {
    const steps = mergeSteps(pendingSteps, liveSteps);
    if (steps.length > 0) {
      const keySeed = steps[0]?.id ?? String(workIndex);
      const isLive = liveSteps.length > 0 || busy;
      blocks.push({
        type: "work",
        key: `work-${keySeed}-${workIndex++}`,
        steps,
        live: isLive,
        defaultOpen: isLive,
      });
    }
  }
  // Empty busy gap is rendered as "Planning next moves" in Chat, not as Thinking.

  return blocks;
}

function isThinkingStep(step: StepItem): boolean {
  return step.kind === "thinking" || /^think/i.test(step.label);
}

/** Wall-clock span for a work block — never sum of step durations. */
function workDurationMs(
  steps: StepItem[],
  now: number,
  live: boolean,
): number | undefined {
  const startedAts = steps
    .map((s) => s.startedAt)
    .filter((t): t is number => typeof t === "number" && t > 0);
  if (startedAts.length === 0) return undefined;
  const start = Math.min(...startedAts);
  if (live || steps.some((s) => s.status === "running")) {
    return Math.max(0, now - start);
  }
  let end = start;
  for (const s of steps) {
    if (typeof s.startedAt === "number" && typeof s.durationMs === "number") {
      end = Math.max(end, s.startedAt + s.durationMs);
    } else if (typeof s.startedAt === "number") {
      end = Math.max(end, s.startedAt);
    }
  }
  return Math.max(0, end - start);
}

function shortFileName(path: string): string {
  const cleaned = path.replace(/\\/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function isEditStep(step: StepItem): boolean {
  const tool = (step.toolName || "").toLowerCase();
  if (tool === "write" || tool === "edit" || tool === "delete") return true;
  return /^(writing|editing|deleting)\b/i.test(step.label);
}

function LineDelta({
  added,
  removed,
  created,
}: {
  added?: number;
  removed?: number;
  created?: number;
}) {
  const plus = created ?? added;
  const hasPlus = typeof plus === "number" && plus > 0;
  const hasMinus = typeof removed === "number" && removed > 0;
  if (!hasPlus && !hasMinus) return null;
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
      {hasPlus ? <span className="text-emerald-400/90">+{plus}</span> : null}
      {hasMinus ? <span className="text-red-400/90">-{removed}</span> : null}
    </span>
  );
}

function workSummary(steps: StepItem[]): string | null {
  const meaningful = steps.filter((s) => !isUsageStep(s));
  if (meaningful.length === 0) return null;
  const explored = meaningful.filter(isExploreStep).length;
  const thoughts = meaningful.filter(isThinkingStep).length;
  const shells = meaningful.filter((s) => /^shell$/i.test(s.label)).length;
  const edits = meaningful.filter(isEditStep).length;
  const parts: string[] = [];
  if (edits) parts.push(`edited ${edits} file${edits === 1 ? "" : "s"}`);
  if (explored) parts.push(`explored ${explored} file${explored === 1 ? "" : "s"}`);
  if (shells) parts.push(`ran ${shells} command${shells === 1 ? "" : "s"}`);
  if (thoughts && parts.length === 0) {
    parts.push(`thought ${thoughts} time${thoughts === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  return parts.map((p, i) => (i === 0 ? p[0]!.toUpperCase() + p.slice(1) : p)).join(", ");
}

function EditFilesSummary({ steps }: { steps: StepItem[] }) {
  const edits = steps.filter(
    (s) => isEditStep(s) && (s.filePath || isEditStep(s)),
  );
  const withPath = edits.filter((s) => Boolean(s.filePath?.trim()));
  if (withPath.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 pl-4">
      {withPath.slice(0, 8).map((step) => (
        <li
          key={step.id}
          className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted"
        >
          <span className="min-w-0 truncate font-mono">
            {shortFileName(step.filePath!)}
          </span>
          <LineDelta
            added={step.linesAdded}
            removed={step.linesRemoved}
            created={step.linesCreated}
          />
        </li>
      ))}
      {withPath.length > 8 ? (
        <li className="text-[11px] text-muted/80">+{withPath.length - 8} more</li>
      ) : null}
    </ul>
  );
}

function DetailPre({
  children,
  followBottom = false,
}: {
  children: string;
  /** When true (live thinking), keep the latest lines visible. */
  followBottom?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !followBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [children, followBottom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const chatScroller = () =>
      el.closest("[data-chat-scroller]") as HTMLElement | null;

    // While finger is on this pane, freeze the parent chat scroller so the
    // nested max-height box can be dragged all the way to its bottom on iOS.
    let locked: HTMLElement | null = null;
    let prevOverflow = "";
    const lockParent = () => {
      if (el.scrollHeight <= el.clientHeight + 1) return;
      const parent = chatScroller();
      if (!parent || locked) return;
      locked = parent;
      prevOverflow = parent.style.overflowY;
      parent.style.overflowY = "hidden";
    };
    const unlockParent = () => {
      if (!locked) return;
      locked.style.overflowY = prevOverflow;
      locked = null;
      prevOverflow = "";
    };

    const onTouchMove = (e: globalThis.TouchEvent) => {
      if (el.scrollHeight <= el.clientHeight + 1) return;
      e.stopPropagation();
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollHeight <= el.clientHeight + 1) return;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) return;
      e.stopPropagation();
    };

    el.addEventListener("touchstart", lockParent, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", unlockParent, { passive: true });
    el.addEventListener("touchcancel", unlockParent, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      unlockParent();
      el.removeEventListener("touchstart", lockParent);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", unlockParent);
      el.removeEventListener("touchcancel", unlockParent);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <pre
      ref={ref}
      className="mt-1.5 ml-4 max-h-64 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-md bg-elevated/80 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted touch-pan-y [-webkit-overflow-scrolling:touch]"
    >
      {children}
    </pre>
  );
}

function StepRow({
  label,
  status,
  durationMs,
  startedAt,
  detail,
  now,
  linesAdded,
  linesRemoved,
  linesCreated,
}: {
  label: string;
  status: "running" | "completed" | "error";
  durationMs?: number;
  startedAt?: number;
  detail?: string;
  /** Shared clock from WorkBlock — avoids per-row intervals. */
  now?: number;
  linesAdded?: number;
  linesRemoved?: number;
  linesCreated?: number;
}) {
  const [open, setOpen] = useState(status === "running");
  const prevStatusRef = useRef(status);
  const canExpand = Boolean(detail?.trim());
  const clock = now ?? Date.now();

  useLayoutEffect(() => {
    if (status === "running") {
      setOpen(true);
    } else if (prevStatusRef.current === "running") {
      setOpen(false);
    }
    prevStatusRef.current = status;
  }, [status]);

  const elapsed =
    durationMs ??
    (status === "running" && typeof startedAt === "number" && startedAt > 0
      ? Math.max(0, clock - startedAt)
      : undefined);

  return (
    <div className="w-full">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 text-left text-[12px] text-muted ${
          canExpand ? "cursor-pointer hover:text-ink" : "cursor-default"
        }`}
        aria-expanded={canExpand ? open : undefined}
        title={canExpand ? (open ? "Hide" : "Show") : undefined}
      >
        {canExpand ? (
          open ? (
            <ChevronDown size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
          ) : (
            <ChevronRight size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
          )
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        <span className={`min-w-0 truncate ${status === "running" ? "text-ink/90" : ""}`}>
          {label}
        </span>
        <LineDelta added={linesAdded} removed={linesRemoved} created={linesCreated} />
        {elapsed != null ? (
          <span className="shrink-0 font-mono tabular-nums text-muted/80">
            {formatDuration(elapsed)}
          </span>
        ) : null}
      </button>
      {open && canExpand ? (
        <DetailPre followBottom={status === "running"}>{detail!}</DetailPre>
      ) : null}
    </div>
  );
}

function ExploredGroup({
  steps,
  now,
  live = false,
}: {
  steps: StepItem[];
  now?: number;
  live?: boolean;
}) {
  const n = steps.length;
  const running = steps.some((s) => s.status === "running");
  const [open, setOpen] = useState(running);
  const wasRunningRef = useRef(running);
  const label = `Explored ${n} file${n === 1 ? "" : "s"}`;
  const clock = now ?? Date.now();
  const duration = workDurationMs(steps, clock, live || running);

  useLayoutEffect(() => {
    if (running) {
      setOpen(true);
    } else if (wasRunningRef.current) {
      setOpen(false);
    }
    wasRunningRef.current = running;
  }, [running]);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-[12px] text-muted hover:text-ink"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
        )}
        <span className={`min-w-0 truncate ${running ? "text-ink/90" : ""}`}>
          {label}
        </span>
        {duration != null ? (
          <span className="shrink-0 font-mono tabular-nums text-muted/80">
            {formatDuration(duration)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-3 mt-1 space-y-1 border-l border-line/60 pl-3">
          {steps.map((step) => (
            <StepRow
              key={step.id}
              label={step.label}
              status={step.status}
              durationMs={step.durationMs}
              startedAt={step.startedAt}
              detail={step.detail}
              now={now}
              linesAdded={step.linesAdded}
              linesRemoved={step.linesRemoved}
              linesCreated={step.linesCreated}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type StepView =
  | { type: "step"; step: StepItem }
  | { type: "explored"; id: string; steps: StepItem[] };

function clusterSteps(steps: StepItem[]): StepView[] {
  const views: StepView[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (isExploreStep(step)) {
      const group: StepItem[] = [];
      while (i < steps.length && isExploreStep(steps[i]!)) {
        group.push(steps[i]!);
        i += 1;
      }
      if (group.length >= 2) {
        views.push({ type: "explored", id: `explored-${group[0]!.id}`, steps: group });
      } else {
        views.push({ type: "step", step: group[0]! });
      }
      continue;
    }
    views.push({ type: "step", step });
    i += 1;
  }
  return views;
}

function WorkBlock({
  steps,
  live,
  defaultOpen,
  clockPaused = false,
}: {
  steps: StepItem[];
  live: boolean;
  defaultOpen: boolean;
  /** Freeze wall-clock while user answers ask_user / AskQuestion. */
  clockPaused?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [now, setNow] = useState(Date.now());
  const prevLiveRef = useRef(live);
  const [blockStart, setBlockStart] = useState<number | null>(null);
  const [blockEnd, setBlockEnd] = useState<number | null>(null);
  const clockPauseStartedRef = useRef<number | null>(null);

  const usageSteps = steps.filter(isUsageStep);
  // Bootstrap planning placeholder / noisy step counters stay out of the nested list.
  const bodySteps = steps.filter(
    (s) =>
      !isUsageStep(s) &&
      !isPlanningPlaceholderId(s.id) &&
      s.kind !== "step",
  );
  const onlyThinking =
    bodySteps.length > 0 && bodySteps.every(isThinkingStep);
  const soleThought = onlyThinking && bodySteps.length === 1 ? bodySteps[0]! : null;
  const hasRunning =
    bodySteps.some((s) => s.status === "running") ||
    (live && bodySteps.length === 0);
  const durationSteps = bodySteps.length > 0 ? bodySteps : steps;

  useLayoutEffect(() => {
    const startedAts = durationSteps
      .map((s) => s.startedAt)
      .filter((t): t is number => typeof t === "number" && t > 0);
    const earliest = startedAts.length > 0 ? Math.min(...startedAts) : null;
    setBlockStart((prev) => {
      if (earliest != null && (prev == null || earliest < prev)) return earliest;
      if (prev == null && live) return Date.now();
      return prev;
    });
  }, [durationSteps, live]);

  useLayoutEffect(() => {
    if (live) {
      setBlockEnd(null);
      return;
    }
    setBlockEnd((prev) => {
      if (prev != null) return prev;
      let end: number | null = null;
      for (const s of durationSteps) {
        if (typeof s.startedAt === "number" && typeof s.durationMs === "number") {
          end = Math.max(end ?? 0, s.startedAt + s.durationMs);
        }
      }
      return end ?? Date.now();
    });
  }, [live, durationSteps]);

  useLayoutEffect(() => {
    if (clockPaused) {
      if (clockPauseStartedRef.current == null) {
        const t = Date.now();
        clockPauseStartedRef.current = t;
        setNow(t);
      }
      return;
    }
    if (clockPauseStartedRef.current != null) {
      const delta = Math.max(0, Date.now() - clockPauseStartedRef.current);
      clockPauseStartedRef.current = null;
      // Shift start forward so ask-wait is excluded from wall-clock.
      setBlockStart((s) => (s != null ? s + delta : s));
      setNow(Date.now());
    }
  }, [clockPaused]);

  useLayoutEffect(() => {
    // Tick while live, but freeze during ask wait.
    if (!live || clockPaused) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live, clockPaused]);

  useLayoutEffect(() => {
    if (!prevLiveRef.current && live) {
      setOpen(true);
    } else if (prevLiveRef.current && !live) {
      setOpen(false);
    }
    prevLiveRef.current = live;
  }, [live]);

  const duration =
    blockStart != null
      ? Math.max(0, (live ? now : (blockEnd ?? now)) - blockStart)
      : workDurationMs(durationSteps, now, live);

  let title: string;
  if (onlyThinking) {
    title =
      hasRunning || soleThought?.status === "running"
        ? duration != null
          ? `Thinking · ${formatDuration(duration)}`
          : "Thinking"
        : duration != null
          ? `Thought for ${formatDuration(duration)}`
          : "Thought";
  } else {
    title = hasRunning || live
      ? duration != null
        ? `Working · ${formatDuration(duration)}`
        : "Working"
      : duration != null
        ? `Worked for ${formatDuration(duration)}`
        : "Worked";
  }

  const clustered = clusterSteps(bodySteps);
  const summary = !open ? workSummary(bodySteps) : null;
  const soleDetail = soleThought?.detail?.trim();
  const showSoleDetail = Boolean(open && soleThought && soleDetail);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-[12px] text-muted hover:text-ink"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
        )}
        <span className={hasRunning || live ? "text-ink/90" : undefined}>{title}</span>
      </button>
      {!open && summary ? (
        <p className="ml-4 mt-0.5 text-[11px] text-muted/80">{summary}</p>
      ) : null}
      {!open ? <EditFilesSummary steps={bodySteps} /> : null}
      {showSoleDetail ? (
        <DetailPre followBottom={hasRunning || soleThought?.status === "running"}>
          {soleDetail!}
        </DetailPre>
      ) : null}
      {open && !soleThought ? (
        <div className="ml-1 mt-1.5 space-y-1 border-l border-line/60 pl-3">
          {clustered.map((view) =>
            view.type === "explored" ? (
              <ExploredGroup key={view.id} steps={view.steps} now={now} live={live} />
            ) : (
              <StepRow
                key={view.step.id}
                label={view.step.label}
                status={view.step.status}
                durationMs={view.step.durationMs}
                startedAt={view.step.startedAt}
                detail={view.step.detail}
                now={now}
                linesAdded={view.step.linesAdded}
                linesRemoved={view.step.linesRemoved}
                linesCreated={view.step.linesCreated}
              />
            ),
          )}
          {usageSteps.map((step) => (
            <p key={step.id} className="text-[11px] text-muted/80">
              {step.label}
            </p>
          ))}
        </div>
      ) : null}
      {open && soleThought && usageSteps.length > 0 ? (
        <div className="ml-4 mt-1 space-y-0.5">
          {usageSteps.map((step) => (
            <p key={step.id} className="text-[11px] text-muted/80">
              {step.label}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Chat({
  messages,
  streamingText,
  activities,
  pendingQuestions = [],
  busy,
  sessionId,
  auth,
  askSubmittingId,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  onRollback,
  onCancelQueued,
  onImplementPlan,
  onAnswerQuestion,
  onSkipQuestion,
  onScrollDirection,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const pendingScrollRestoreRef = useRef<{ height: number; top: number } | null>(
    null,
  );
  const loadOlderLockRef = useRef(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const persistedActivityIds = new Set(
    messages
      .filter((message) => message.role === "activity" && message.activityId)
      .map((message) => message.activityId as string),
  );
  const liveOnly = activities.filter(
    (item) =>
      item.status === "running" ||
      (!isPlanningPlaceholderId(item.id) && !persistedActivityIds.has(item.id)),
  );

  /** Real agent output that should replace the planning placeholder. */
  const hasVisibleOutput = (() => {
    if (streamingText.trim()) return true;
    if (pendingQuestions.length > 0) return true;
    for (const item of liveOnly) {
      if (isPlanningPlaceholderId(item.id)) continue;
      if (item.kind === "thinking") {
        if (item.detail?.trim()) return true;
        continue;
      }
      if (item.kind === "usage") continue;
      return true;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role !== "user") continue;
      for (let j = i + 1; j < messages.length; j += 1) {
        const m = messages[j]!;
        if (m.role === "assistant" && m.content.trim()) return true;
        if (m.role === "tool") return true;
        if (m.role === "activity") {
          if (m.activityKind === "thinking") {
            if (m.detail?.trim()) return true;
            continue;
          }
          if (m.activityKind && m.activityKind !== "usage") return true;
        }
      }
      break;
    }
    return false;
  })();

  const timelineLive = liveOnly.filter((item) => {
    if (isPlanningPlaceholderId(item.id)) return false;
    // Keep empty thinking shells out of the timeline so Planning stays visible.
    if (item.kind === "thinking" && !item.detail?.trim()) return false;
    return true;
  });

  const showPlanning = Boolean(busy) && !hasVisibleOutput;
  const planningStartedAt = useMemo(() => {
    const placeholder = activities.find(
      (item) => isPlanningPlaceholderId(item.id) && item.status === "running",
    );
    return placeholder?.startedAt;
  }, [activities]);
  const [planningNow, setPlanningNow] = useState(() => Date.now());
  useEffect(() => {
    if (!showPlanning) return;
    setPlanningNow(Date.now());
    const id = window.setInterval(() => setPlanningNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [showPlanning]);
  const planningElapsed =
    showPlanning && planningStartedAt
      ? Math.max(0, planningNow - planningStartedAt)
      : undefined;

  /** Wall-clock start for the in-progress reply (live elapsed timer). */
  const liveReplyStartedAt = useMemo(() => {
    if (!busy) return undefined;
    const candidates: number[] = [];
    if (typeof planningStartedAt === "number" && planningStartedAt > 0) {
      candidates.push(planningStartedAt);
    }
    for (const item of activities) {
      if (typeof item.startedAt === "number" && item.startedAt > 0) {
        candidates.push(item.startedAt);
      }
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") {
        candidates.push(messages[i]!.createdAt);
        break;
      }
    }
    if (candidates.length === 0) return undefined;
    return Math.min(...candidates);
  }, [busy, planningStartedAt, activities, messages]);

  const askWaiting = pendingQuestions.length > 0;
  const askPauseStartedRef = useRef<number | null>(null);
  const [askPausedAccumMs, setAskPausedAccumMs] = useState(0);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!busy) {
      askPauseStartedRef.current = null;
      setAskPausedAccumMs(0);
      return;
    }
    if (askWaiting) {
      if (askPauseStartedRef.current == null) {
        const now = Date.now();
        askPauseStartedRef.current = now;
        setLiveNow(now);
      }
      return;
    }
    if (askPauseStartedRef.current != null) {
      const started = askPauseStartedRef.current;
      askPauseStartedRef.current = null;
      setAskPausedAccumMs((prev) => prev + Math.max(0, Date.now() - started));
    }
  }, [busy, askWaiting]);

  useEffect(() => {
    // Freeze while an ask card waits for the user.
    if (!busy || liveReplyStartedAt == null || askWaiting) return;
    setLiveNow(Date.now());
    const id = window.setInterval(() => setLiveNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [busy, liveReplyStartedAt, askWaiting]);

  const liveElapsed =
    busy && liveReplyStartedAt != null
      ? Math.max(
          0,
          liveNow -
            liveReplyStartedAt -
            askPausedAccumMs -
            (askPauseStartedRef.current != null
              ? Math.max(0, liveNow - askPauseStartedRef.current)
              : 0),
        )
      : undefined;

  const timeline = useMemo(
    () => buildTimeline(messages, timelineLive.map(liveToStep), Boolean(busy)),
    // timelineLive contents drive live steps; identity changes every activity tick by design
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, activities, busy, timelineLive, streamingText],
  );

  const hasRunningLive = timelineLive.some((item) => item.status === "running");

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (messages.length > prevMessageCountRef.current && last?.role === "user") {
      stickToBottomRef.current = true;
      setShowJumpToBottom(false);
    }
    prevMessageCountRef.current = messages.length;

    const pending = pendingScrollRestoreRef.current;
    const el = scrollerRef.current;
    if (pending && el) {
      el.scrollTop = el.scrollHeight - pending.height + pending.top;
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (!stickToBottomRef.current) return;
    if (!el) return;
    // Avoid scrolling on every thinking tick — that reflows video and jitters the chat.
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, timelineLive.length, timeline.length, showPlanning]);

  useEffect(() => {
    if (!loadingOlder) loadOlderLockRef.current = false;
  }, [loadingOlder]);

  async function tryLoadOlder() {
    if (!hasMoreOlder || !onLoadOlder || loadingOlder || loadOlderLockRef.current) {
      return;
    }
    const el = scrollerRef.current;
    if (!el) return;
    loadOlderLockRef.current = true;
    pendingScrollRestoreRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
    };
    try {
      await onLoadOlder();
    } catch {
      pendingScrollRestoreRef.current = null;
      loadOlderLockRef.current = false;
    }
  }

  // Keep pinned to bottom when auto-expanded steps grow the layout.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        data-chat-scroller
        className="absolute inset-0 overflow-y-auto overflow-x-hidden px-4 pb-4 pt-14 md:px-6"
        onScroll={() => {
          const el = scrollerRef.current;
          if (!el) return;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          const nearBottom = distance < NEAR_BOTTOM_PX;
          stickToBottomRef.current = nearBottom;
          setShowJumpToBottom(!nearBottom);

          if (el.scrollTop < 80) {
            void tryLoadOlder();
          }

          if (onScrollDirection) {
            const top = el.scrollTop;
            const delta = top - lastScrollTopRef.current;
            lastScrollTopRef.current = top;
            // Stick-to-bottom growth looks like scroll-down — don't hide the header.
            if (nearBottom && delta > 0) return;
            if (top <= 8) {
              onScrollDirection("up", top);
            } else if (Math.abs(delta) >= 8) {
              onScrollDirection(delta > 0 ? "down" : "up", top);
            }
          }
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pb-2">
          {hasMoreOlder ? (
            <div className="flex justify-center py-2">
              <button
                type="button"
                disabled={loadingOlder}
                onClick={() => void tryLoadOlder()}
                className="rounded-md px-3 py-1 text-[11px] text-muted transition-colors hover:bg-white/[0.04] hover:text-ink disabled:opacity-50"
              >
                {loadingOlder ? "Loading earlier…" : "Load earlier messages"}
              </button>
            </div>
          ) : null}

          {messages.length === 0 && !streamingText && !showPlanning && timeline.length === 0 && (
            <p className="py-16 text-center text-sm text-muted">
              Send a message to start talking to the local agent.
            </p>
          )}

          {timeline.map((block) => {
            if (block.type === "user") {
              const message = block.message;
              const canRollback = !busy && Boolean(onRollback);
              const isPlanTurn = message.mode === "plan";
              return (
                <div key={block.key} className="group relative w-full">
                  <div className="w-full rounded-xl bg-elevated px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                    {isPlanTurn || message.queued ? (
                      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                        {isPlanTurn ? (
                          <span className="inline-block rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                            Plan
                          </span>
                        ) : null}
                        {message.queued ? (
                          <span className="inline-flex items-center gap-1 rounded bg-accent/15 py-0.5 pl-1.5 pr-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                            Queued
                            {onCancelQueued && String(message.id).startsWith("local-") ? (
                              <button
                                type="button"
                                onClick={() => onCancelQueued(message.id)}
                                className="inline-flex h-4 w-4 items-center justify-center rounded text-accent/80 transition-colors hover:bg-accent/20 hover:text-accent"
                                title="Remove from queue"
                                aria-label="Remove from queue"
                              >
                                <X size={11} strokeWidth={2} aria-hidden />
                              </button>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {message.images?.length ? (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {message.images.map((image, imageIndex) => (
                          <OpenableImage
                            key={`${message.id}-img-${imageIndex}`}
                            src={image.dataUrl}
                            alt=""
                            className="max-h-40 rounded-md object-cover ring-1 ring-line"
                          />
                        ))}
                      </div>
                    ) : null}
                    {message.content ? (
                      <MarkdownBody text={message.content} sessionId={sessionId} auth={auth} />
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <MessageTimestamp createdAt={message.createdAt} />
                    <CopyButton text={message.content} />
                    {canRollback ? (
                      <button
                        type="button"
                        onClick={() => onRollback?.(message.id)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-white/[0.04] hover:text-ink md:opacity-70 md:group-hover:opacity-100"
                        title={
                          message.checkpointSha
                            ? "Restore files and chat to this message"
                            : "Restore chat to this message (no file checkpoint)"
                        }
                      >
                        <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
                        Restore
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            }
            if (block.type === "work") {
              return (
                <WorkBlock
                  key={block.key}
                  steps={block.steps}
                  live={block.live}
                  defaultOpen={block.defaultOpen}
                  clockPaused={askWaiting}
                />
              );
            }
            if (block.type === "question") {
              const message = block.message;
              return (
                <AskQuestionCard
                  key={block.key}
                  callId={message.questionCallId ?? message.id}
                  title={message.questionTitle}
                  questions={message.questionItems ?? []}
                  status={message.questionStatus ?? "answered"}
                  answers={message.questionAnswers}
                />
              );
            }
            const isPlanDocument = isPlanDocumentMessage(
              block.message,
              messages,
            );
            // Button lives inside the plan card header; show on every plan bubble.
            return (
              <AssistantMessage
                key={block.key}
                text={block.message.content}
                sessionId={sessionId}
                auth={auth}
                isPlanDocument={isPlanDocument}
                createdAt={block.message.createdAt}
                durationMs={resolveAssistantDurationMs(block.message, messages)}
                onImplementPlan={
                  isPlanDocument ? onImplementPlan : undefined
                }
              />
            );
          })}

          {pendingQuestions.map((question) => (
            <AskQuestionCard
              key={question.callId}
              callId={question.callId}
              title={question.title}
              questions={question.questions}
              status="pending"
              submitting={askSubmittingId === question.callId}
              onSubmit={(answers) => onAnswerQuestion?.(question.callId, answers)}
              onSkip={() => onSkipQuestion?.(question.callId)}
            />
          ))}

          {streamingText ? (
            <div className="w-full">
              <div className="w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                {streamingText}
                {!hasRunningLive ? (
                  <span className="ml-1 text-muted" aria-hidden>
                    …
                  </span>
                ) : null}
              </div>
              {liveElapsed != null ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <MessageDuration durationMs={liveElapsed} live />
                </div>
              ) : null}
            </div>
          ) : null}

          {showPlanning ? (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span
                className="relative inline-flex h-1.5 w-1.5 shrink-0"
                aria-hidden
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-50" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              <span>
                Planning next moves
                {planningElapsed != null ? ` · ${formatDuration(planningElapsed)}` : "…"}
              </span>
            </div>
          ) : null}

          {/* Always-visible live timer while generating (when not already shown above). */}
          {busy && liveElapsed != null && !streamingText && !showPlanning ? (
            <div className="flex flex-wrap items-center gap-2">
              <MessageDuration durationMs={liveElapsed} live />
            </div>
          ) : null}
        </div>
      </div>

      {showJumpToBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          className="absolute bottom-3 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full bg-elevated text-ink shadow-md ring-1 ring-line transition hover:bg-panel"
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          <ArrowDown {...iconProps} />
        </button>
      ) : null}
    </div>
  );
}
