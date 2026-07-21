import { useEffect, useRef, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { BoardPanel } from "./components/BoardPanel";
import { Chat } from "./components/Chat";
import { ChildAgentsStrip } from "./components/ChildAgentsStrip";
import { Composer } from "./components/Composer";
import { DeployBanner } from "./components/DeployBanner";
import { SessionList } from "./components/SessionList";
import { SettingsPanel } from "./components/SettingsPanel";
import { BootSplash, ChatSkeleton } from "./components/Skeleton";
import { WorkspacePicker } from "./components/WorkspacePicker";
import {
  answerAskQuestion,
  cancelQueuedMessage,
  cancelRun,
  connectSocket,
  createSession,
  deleteSession,
  fetchHealth,
  getDeployStatus,
  getSession,
  listModels,
  listPendingAskQuestions,
  listProjects,
  listProjectSessions,
  loadStoredToken,
  MESSAGE_PAGE_SIZE,
  rollbackMessage,
  sendMessage,
  storeToken,
  updateSessionMode,
  updateSession,
  type AskQuestionAnswer,
  type AuthMode,
  type ActivityItem,
  type ChatMessage,
  type DeployStatus,
  type ModelOption,
  type ProjectListItem,
  type SendImagePayload,
  type SessionSummary,
  type StreamEvent,
  type TokenUsage,
  type ContextSnapshot,
} from "./lib/api";
import { latestContextFromMessages } from "./lib/contextUsage";
import {
  enablePushNotifications,
  notifyAgentDone,
  notifyAskWaiting,
  resumePushNotifications,
  shouldOfferPushEnable,
} from "./lib/notify";
import type { PendingAskQuestion } from "./components/Chat";

const MODEL_KEY = "webcli.lastModel";
const MODE_KEY = "webcli.lastMode";
const MODEL_KEY_LEGACY = "cursor-cli.lastModel";
const MODE_KEY_LEGACY = "cursor-cli.lastMode";
const SESSION_KEY = "webcli.lastSessionId";
const SESSION_KEY_LEGACY = "cursor-cli.lastSessionId";
const PROJECT_PAGE_SIZE = 12;
const SESSIONS_PER_PROJECT = 8;

function clearStoredSessionId(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY_LEGACY);
  } catch {
    /* ignore */
  }
}

function isMissingSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === "Session not found" || message.includes("HTTP 404");
}

/** Place an answered ask card after its tool activity row when possible. */
function insertQuestionAfterActivity(
  prev: ChatMessage[],
  message: ChatMessage,
  callId: string,
  toolCallId?: string,
): ChatMessage[] {
  const anchorIds = [toolCallId, callId, message.questionCallId].filter(
    (id): id is string => Boolean(id),
  );
  let activityIdx = -1;
  for (const anchor of anchorIds) {
    activityIdx = prev.findIndex(
      (m) => m.role === "activity" && m.activityId === anchor,
    );
    if (activityIdx >= 0) break;
  }
  if (activityIdx < 0) {
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i]!;
      if (m.role !== "activity") continue;
      const key = `${m.toolName || ""} ${m.content || ""}`.toLowerCase().replace(/[_-]/g, "");
      if (key.includes("askuser") || key.includes("askquestion")) {
        activityIdx = i;
        break;
      }
    }
  }
  if (activityIdx < 0) return [...prev, message];
  const next = [...prev];
  next.splice(activityIdx + 1, 0, message);
  return next;
}

function flattenProjects(projects: ProjectListItem[]): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const project of projects) {
    out.push(...project.sessions, ...project.children);
  }
  return out;
}

function mergeSessionLists(
  prev: SessionSummary[],
  extra: SessionSummary[],
): SessionSummary[] {
  const map = new Map(prev.map((s) => [s.id, s]));
  for (const s of extra) map.set(s.id, s);
  return [...map.values()];
}

/** Keep already-loaded older messages when refreshing the newest page. */
function imageOnlyPlaceholder(content: string): boolean {
  const t = content.trim();
  return t === "" || t === "(image)";
}

/** Match optimistic local-* bubble to the server user message it became. */
function matchesOptimisticUser(
  local: ChatMessage,
  server: ChatMessage,
): boolean {
  if (local.role !== "user" || server.role !== "user") return false;
  if (server.clientMessageId && local.id === server.clientMessageId) return true;
  if (local.content === server.content) return true;
  // Image-only: client used to send "" while server stores "(image)".
  const localImgs = local.images?.length ?? 0;
  const serverImgs = server.images?.length ?? 0;
  if (
    localImgs > 0 &&
    serverImgs > 0 &&
    imageOnlyPlaceholder(local.content) &&
    imageOnlyPlaceholder(server.content)
  ) {
    return true;
  }
  return false;
}

function mergeTailRefresh(
  serverTail: ChatMessage[],
  prev: ChatMessage[],
): ChatMessage[] {
  const pending = prev.filter((m) => {
    if (m.role !== "user" || !String(m.id).startsWith("local-")) return false;
    return !serverTail.some((s) => matchesOptimisticUser(m, s));
  });
  if (!serverTail.length) {
    return pending.length ? [...serverTail, ...pending] : serverTail;
  }
  const anchor = serverTail[0]!.id;
  const anchorIdx = prev.findIndex((m) => m.id === anchor);
  const older = anchorIdx > 0 ? prev.slice(0, anchorIdx) : [];
  const merged = [...older, ...serverTail];
  return pending.length ? [...merged, ...pending] : merged;
}

type LiveActivity = ActivityItem & { startedAt?: number };

function loadStoredModel(): string {
  try {
    return (
      localStorage.getItem(MODEL_KEY) ||
      localStorage.getItem(MODEL_KEY_LEGACY) ||
      "auto"
    );
  } catch {
    return "auto";
  }
}

function storeModel(modelId: string): void {
  try {
    localStorage.setItem(MODEL_KEY, modelId);
  } catch {
    /* ignore */
  }
}

function loadStoredMode(): "agent" | "plan" {
  try {
    const raw =
      localStorage.getItem(MODE_KEY) || localStorage.getItem(MODE_KEY_LEGACY);
    return raw === "plan" ? "plan" : "agent";
  } catch {
    return "agent";
  }
}

function storeMode(mode: "agent" | "plan"): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

const RELOAD_AFTER_DEPLOY_KEY = "cli-web-reload-after-deploy";

function markReloadAfterDeploy(): void {
  try {
    localStorage.setItem(RELOAD_AFTER_DEPLOY_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function clearReloadAfterDeploy(): void {
  try {
    localStorage.removeItem(RELOAD_AFTER_DEPLOY_KEY);
  } catch {
    /* ignore */
  }
}

function hasReloadAfterDeploy(): boolean {
  try {
    return Boolean(localStorage.getItem(RELOAD_AFTER_DEPLOY_KEY));
  } catch {
    return false;
  }
}

function hardReloadApp(): void {
  clearReloadAfterDeploy();
  const url = new URL(window.location.href);
  url.searchParams.set("_r", String(Date.now()));
  window.location.replace(url.toString());
}

export default function App() {
  const [accessToken, setAccessToken] = useState(() => loadStoredToken());
  const [tokenDraft, setTokenDraft] = useState(accessToken);
  const [isStand, setIsStand] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projectItems, setProjectItems] = useState<ProjectListItem[]>([]);
  const [hasMoreProjects, setHasMoreProjects] = useState(false);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);
  const [loadingSessionsKey, setLoadingSessionsKey] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState(loadStoredModel);
  const [mode, setMode] = useState<"agent" | "plan">(loadStoredMode);
  const [models, setModels] = useState<ModelOption[]>([
    { id: "auto", displayName: "Auto" },
  ]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [askPendingIds, setAskPendingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [activities, setActivities] = useState<LiveActivity[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<PendingAskQuestion[]>([]);
  const [askSubmittingId, setAskSubmittingId] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [composerDraftKey, setComposerDraftKey] = useState(0);
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [lastContext, setLastContext] = useState<ContextSnapshot | null>(null);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [showNotifyBanner, setShowNotifyBanner] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const projectItemsRef = useRef<ProjectListItem[]>([]);
  const sendingRef = useRef<Set<string>>(new Set());
  const busyIdsRef = useRef<Set<string>>(new Set());
  const deployOfflineSeenRef = useRef(false);
  const deployScheduledRef = useRef(false);
  const socketRef = useRef<ReturnType<typeof connectSocket> | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const foregroundResyncTimerRef = useRef<number | undefined>(undefined);
  const resyncInFlightRef = useRef<Promise<boolean> | null>(null);
  const resyncStartedAtRef = useRef<number | null>(null);
  /** Dedupe restore prompt from HTTP + delayed WS (phone often gets WS seconds later). */
  const rollbackDraftTokenRef = useRef<string | null>(null);

  const auth: AuthMode = { accessToken };
  const authenticated = Boolean(auth.accessToken);
  const busy = Boolean(activeId && busyIds.has(activeId));
  const activeSession = sessions.find((s) => s.id === activeId);
  const projectWorkspace =
    activeSession?.projectWorkspace ||
    (activeSession?.parentSessionId
      ? sessions.find((s) => s.id === activeSession.parentSessionId)?.workspace
      : null) ||
    workspace;
  const childAgentsForActive = activeId
    ? sessions
        .filter((s) => s.parentSessionId === activeId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  useEffect(() => {
    busyIdsRef.current = busyIds;
  }, [busyIds]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    projectItemsRef.current = projectItems;
  }, [projectItems]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    deployScheduledRef.current = Boolean(deployStatus?.scheduled);
  }, [deployStatus?.scheduled]);

  // Swipe right anywhere to open the sidebar (mobile). Close stays tap-outside.
  useEffect(() => {
    if (sidebarOpen || toolsOpen || boardOpen) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!t) return;
      const target = e.target as Element | null;
      if (target?.closest("textarea, input, select, [data-no-sidebar-swipe]")) {
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Vertical scroll / slight diagonal — ignore.
      if (Math.abs(dy) >= Math.abs(dx)) {
        if (Math.abs(dy) > 10) tracking = false;
        return;
      }
      if (dx > 48) {
        tracking = false;
        setSidebarOpen(true);
      }
    };
    const onEnd = () => {
      tracking = false;
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [sidebarOpen, toolsOpen, boardOpen]);

  // After release restart: wait until /api/health is back (saw downtime), then hard-reload.
  // Works on Android/PWA where WS may die before deploy_restarting arrives.
  useEffect(() => {
    if (!authenticated) return;
    if (!deployStatus?.scheduled && !hasReloadAfterDeploy()) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await fetchHealth();
        if (cancelled) return;
        if (hasReloadAfterDeploy() && deployOfflineSeenRef.current) {
          hardReloadApp();
        }
      } catch {
        deployOfflineSeenRef.current = true;
        markReloadAfterDeploy();
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, deployStatus?.scheduled, deployStatus?.waitingForIdle]);

  useEffect(() => {
    let cancelled = false;
    void fetchHealth()
      .then((info) => {
        if (cancelled) return;
        const stand = Boolean(info.stand);
        setIsStand(stand);
        document.title = stand ? "WebCLI [stand]" : "WebCLI";
        if (info.deploy?.scheduled) setDeployStatus(info.deploy);
      })
      .catch(() => {
        /* API may still be starting */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void getDeployStatus(auth)
      .then((status) => {
        if (!cancelled) setDeployStatus(status.scheduled ? status : null);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  function markBusy(sessionId: string, next: boolean) {
    setBusyIds((prev) => {
      const has = prev.has(sessionId);
      if (next === has) return prev;
      const copy = new Set(prev);
      if (next) copy.add(sessionId);
      else copy.delete(sessionId);
      return copy;
    });
  }

  function clearSending(sessionId: string) {
    sendingRef.current.delete(sessionId);
  }

  function clearLiveRunUi(opts?: { keepPendingQuestions?: boolean }) {
    setStreamingText("");
    setActivities([]);
    if (!opts?.keepPendingQuestions) {
      setPendingQuestions([]);
      setAskSubmittingId(null);
    }
  }

  /**
   * Authoritative busy from the server. Local `sendingRef` must not keep Stop /
   * "Planning next moves" after a missed WS `done` (common on phone resume).
   */
  function syncBusyFromServer(sessionId: string, serverBusy: boolean) {
    if (serverBusy) {
      markBusy(sessionId, true);
      return;
    }
    clearSending(sessionId);
    markBusy(sessionId, false);
    if (activeIdRef.current === sessionId) {
      clearLiveRunUi({ keepPendingQuestions: true });
    }
  }

  /** Apply /api/.../ask-questions into local card state. */
  function applyPendingFromServer(
    sessionId: string,
    items: Array<{
      callId: string;
      toolCallId: string;
      title?: string;
      questions: PendingAskQuestion["questions"];
    }>,
  ) {
    const mapped: PendingAskQuestion[] = items.map((item) => ({
      callId: item.callId,
      toolCallId: item.toolCallId,
      title: item.title,
      questions: item.questions,
    }));
    setPendingQuestions((prev) => {
      if (mapped.length > 0) return mapped;
      // Empty list must not wipe a card that just arrived via WS while an
      // in-flight listPending raced ahead of pendingByCallId registration.
      if (
        prev.length > 0 &&
        (busyIdsRef.current.has(sessionId) || sendingRef.current.has(sessionId))
      ) {
        return prev;
      }
      return [];
    });
    setAskPendingIds((prev) => {
      const next = new Set(prev);
      if (mapped.length > 0) next.add(sessionId);
      else if (
        !busyIdsRef.current.has(sessionId) &&
        !sendingRef.current.has(sessionId)
      ) {
        next.delete(sessionId);
      }
      return next;
    });
    if (mapped.length === 0 && !busyIdsRef.current.has(sessionId)) {
      setAskSubmittingId(null);
    }
  }

  function pullPendingAskQuestions(sessionId: string) {
    void listPendingAskQuestions(auth, sessionId)
      .then((pending) => {
        if (activeIdRef.current !== sessionId) return;
        applyPendingFromServer(sessionId, pending.pending);
      })
      .catch(() => {
        /* keep existing cards */
      });
  }

  /**
   * After backgrounding / WS drop we often miss `done`. Re-pull session list +
   * active chat so busy/ticking UI cannot stick forever.
   * @returns true when the active chat was refreshed (or there is no active chat).
   */
  async function resyncFromServer(opts?: {
    reloadActive?: boolean;
    /** Longer away → treat hung sockets / stale merge more aggressively. */
    longAway?: boolean;
  }): Promise<boolean> {
    if (!authenticated) return false;

    // A hung fetch after mobile suspend used to block every later resync forever.
    const inFlight = resyncInFlightRef.current;
    if (inFlight) {
      const age =
        resyncStartedAtRef.current != null
          ? Date.now() - resyncStartedAtRef.current
          : 0;
      if (age < 15_000) return inFlight;
      resyncInFlightRef.current = null;
      resyncStartedAtRef.current = null;
    }

    const timeoutMs = opts?.longAway ? 12_000 : 10_000;
    resyncStartedAtRef.current = Date.now();

    const run = (async (): Promise<boolean> => {
      try {
        const projectCount = Math.max(PROJECT_PAGE_SIZE, projectItemsRef.current.length);
        const sessionsLimit = Math.max(
          SESSIONS_PER_PROJECT,
          ...projectItemsRef.current.map((p) => p.sessions.length),
        );
        const { projects, hasMore } = await listProjects(auth, {
          limit: projectCount,
          sessionsLimit,
          timeoutMs,
        });
        setProjectItems(projects);
        projectItemsRef.current = projects;
        setHasMoreProjects(hasMore);
        const items = flattenProjects(projects);
        setSessions(items);
        sessionsRef.current = items;
        setBusyIds((prev) => {
          const next = new Set(prev);
          for (const item of items) {
            if (item.busy) next.add(item.id);
            else {
              // Trust list: idle on server → drop local send latch too.
              sendingRef.current.delete(item.id);
              next.delete(item.id);
            }
          }
          for (const id of [...next]) {
            if (!items.some((item) => item.id === id) && !sendingRef.current.has(id)) {
              next.delete(id);
            }
          }
          busyIdsRef.current = next;
          return next;
        });

        const id = activeIdRef.current;
        if (!id) return true;
        const summary = items.find((item) => item.id === id);
        const serverBusy = Boolean(summary?.busy);
        syncBusyFromServer(id, serverBusy);

        if (opts?.reloadActive === false) return true;

        const detail = await getSession(auth, id, {
          limit: MESSAGE_PAGE_SIZE,
          timeoutMs,
        });
        setMessages((prev) => {
          // After a long suspend, prefer the server page outright — merge can
          // keep a confusing half-stale timeline if ids drifted while frozen.
          if (opts?.longAway) {
            const pending = prev.filter((m) => {
              if (m.role !== "user" || !String(m.id).startsWith("local-")) return false;
              return !detail.messages.some((s) => matchesOptimisticUser(m, s));
            });
            return pending.length
              ? [...detail.messages, ...pending]
              : detail.messages;
          }
          const merged = mergeTailRefresh(detail.messages, prev);
          setHasMoreOlder(
            Boolean(detail.hasMoreOlder) ||
              (merged.length > detail.messages.length &&
                merged[0]?.id !== detail.messages[0]?.id),
          );
          return merged;
        });
        if (opts?.longAway) {
          setHasMoreOlder(Boolean(detail.hasMoreOlder));
        }
        syncBusyFromServer(id, Boolean(detail.busy));
        if (detail.context) {
          setLastContext(detail.context);
          setLastUsage(detail.usage ?? latestContextFromMessages(detail.messages)?.usage ?? null);
        } else {
          const latest = latestContextFromMessages(detail.messages);
          setLastUsage(latest?.usage ?? null);
          setLastContext(latest?.context ?? null);
        }
        try {
          const pending = await listPendingAskQuestions(auth, id, { timeoutMs });
          applyPendingFromServer(id, pending.pending);
        } catch {
          /* older server / race — keep existing pending cards */
        }
        return true;
      } catch (err) {
        if (isMissingSessionError(err)) {
          clearStoredSessionId();
          const fallback = sessionsRef.current.find((s) => s.id !== activeIdRef.current);
          if (fallback) {
            await openSession(fallback.id);
            return true;
          }
          setActiveId(null);
          setShowNew(true);
          return true;
        }
        console.warn("resync failed", err);
        return false;
      } finally {
        resyncInFlightRef.current = null;
        resyncStartedAtRef.current = null;
      }
    })();

    resyncInFlightRef.current = run;
    return run;
  }

  /** Resume after long background: force WS + retry HTTP resync while network wakes up. */
  function scheduleForegroundResync(reason: string) {
    if (!authenticated) return;
    if (foregroundResyncTimerRef.current !== undefined) {
      window.clearTimeout(foregroundResyncTimerRef.current);
      foregroundResyncTimerRef.current = undefined;
    }

    const hiddenForMs =
      hiddenAtRef.current != null ? Date.now() - hiddenAtRef.current : 0;
    // Keep hiddenAt until we actually start — coalesced focus/visibility events share it.
    // Unknown duration (freeze without visibility) → assume we need a fresh socket.
    const shouldForceWs =
      reason === "online" ||
      reason === "sw" ||
      reason === "resume" ||
      hiddenAtRef.current == null ||
      hiddenForMs >= 3_000;
    const longAway =
      hiddenForMs >= 60_000 ||
      reason === "resume" ||
      reason === "sw" ||
      // Never saw "hidden" (frozen PWA) — assume a long suspend.
      (hiddenAtRef.current == null &&
        (reason === "visibility" || reason === "pageshow" || reason === "focus"));

    const delays = [0, 400, 1_200, 3_000, 7_000, 15_000];
    let attempt = 0;

    const tick = () => {
      foregroundResyncTimerRef.current = undefined;
      if (attempt === 0) {
        hiddenAtRef.current = null;
        if (shouldForceWs) socketRef.current?.reconnectNow();
      }
      void (async () => {
        const ok = await resyncFromServer({ longAway });
        if (ok || attempt >= delays.length - 1) return;
        if (document.visibilityState === "hidden") return;
        attempt += 1;
        foregroundResyncTimerRef.current = window.setTimeout(tick, delays[attempt]!);
      })();
    };

    // Debounce stacked visibility/focus/pageshow on mobile resume.
    foregroundResyncTimerRef.current = window.setTimeout(tick, 120);
  }

  // Foreground / bfcache restore — phone often missed WS `done` while suspended.
  useEffect(() => {
    if (!authenticated) return;

    const markHidden = () => {
      if (hiddenAtRef.current == null) hiddenAtRef.current = Date.now();
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        markHidden();
        return;
      }
      scheduleForegroundResync("visibility");
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted || document.visibilityState === "visible") {
        scheduleForegroundResync("pageshow");
      }
    };
    const onFocus = () => {
      // Only when we actually left the foreground — avoids WS thrash on every tap.
      if (document.visibilityState !== "visible") return;
      if (hiddenAtRef.current == null) return;
      scheduleForegroundResync("focus");
    };
    const onOnline = () => {
      scheduleForegroundResync("online");
    };
    const onFreeze = () => {
      markHidden();
    };
    const onResume = () => {
      scheduleForegroundResync("resume");
    };
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null;
      const type = data?.type;
      if (type === "webcli:resync") scheduleForegroundResync("sw");
      if (type === "webcli:open-session" && data?.sessionId) {
        void openSession(data.sessionId);
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    // Chromium Page Lifecycle — fires when the tab is frozen/resumed without a
    // reliable visibilitychange (common on Android PWAs after 10+ minutes).
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
      if (foregroundResyncTimerRef.current !== undefined) {
        window.clearTimeout(foregroundResyncTimerRef.current);
        foregroundResyncTimerRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  useEffect(() => {
    if (!authenticated) return;
    void (async () => {
      const resumed = await resumePushNotifications(auth);
      if (!resumed && shouldOfferPushEnable()) {
        setShowNotifyBanner(true);
      } else {
        setShowNotifyBanner(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void (async () => {
      setModelsLoading(true);
      try {
        const items = await listModels(auth);
        if (cancelled) return;
        setModels(items);
        if (!items.some((item) => item.id === model)) {
          const next = items.some((item) => item.id === "auto") ? "auto" : items[0]?.id || "auto";
          setModel(next);
          storeModel(next);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void (async () => {
      setBootLoading(true);
      try {
        const { projects, hasMore } = await listProjects(auth, {
          limit: PROJECT_PAGE_SIZE,
          sessionsLimit: SESSIONS_PER_PROJECT,
        });
        if (cancelled) return;
        setProjectItems(projects);
        setHasMoreProjects(hasMore);
        const items = flattenProjects(projects);
        setSessions(items);
        let lastId: string | null = null;
        try {
          const fromUrl = new URLSearchParams(window.location.search).get("session");
          lastId =
            fromUrl ||
            localStorage.getItem(SESSION_KEY) ||
            localStorage.getItem(SESSION_KEY_LEGACY);
          if (fromUrl) {
            const url = new URL(window.location.href);
            url.searchParams.delete("session");
            window.history.replaceState({}, "", url.pathname + url.search + url.hash);
          }
        } catch {
          lastId = null;
        }
        if (lastId && items.some((s) => s.id === lastId)) {
          await openSession(lastId);
        } else if (items[0]) {
          await openSession(items[0].id);
        } else if (lastId) {
          // Session may exist but be outside the first project page — open by id.
          await openSession(lastId);
        } else {
          setShowNew(true);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    let handle: ReturnType<typeof connectSocket> | null = null;
    // Defer connect so React Strict Mode remount does not abort the handshake.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      handle = connectSocket(
        auth,
        (event: StreamEvent) => {
          if (event.type === "ping" || event.type === "pong") return;

          if (event.type === "deploy_scheduled") {
            const waiting = (event.message ?? "")
              .toLowerCase()
              .includes("waiting");
            markReloadAfterDeploy();
            setDeployStatus({
              scheduled: true,
              restartAt: event.restartAt,
              forceAt: event.forceAt,
              delayMinutes: event.delayMinutes,
              busySessions: 0,
              waitingForIdle: waiting,
              message: event.message ?? null,
            });
            return;
          }
          if (event.type === "deploy_cancelled") {
            setDeployStatus(null);
            clearReloadAfterDeploy();
            deployOfflineSeenRef.current = false;
            return;
          }
          if (event.type === "deploy_restarting") {
            markReloadAfterDeploy();
            setDeployStatus({
              scheduled: true,
              restartAt: Date.now(),
              forceAt: Date.now(),
              delayMinutes: 0,
              busySessions: 0,
              waitingForIdle: false,
              message: event.message ?? "Restarting release…",
            });
            setError("Release is restarting — page will reload…");
            return;
          }

          if (event.type === "error" && !("sessionId" in event && event.sessionId)) {
            setError(event.message);
            return;
          }

          // Track busy for every session so the sidebar can show parallel work.
          if (event.type === "status" && event.sessionId && event.status === "RUNNING") {
            // Send was accepted — drop the local "starting" latch.
            clearSending(event.sessionId);
            markBusy(event.sessionId, true);
          }
          if (event.type === "activity" && event.sessionId && event.status === "running") {
            clearSending(event.sessionId);
            markBusy(event.sessionId, true);
          }
          if (event.type === "done" && event.sessionId) {
            // Phantom "finished" with no runId = old healStuckBusy during prepare.
            // Real completions always carry a run id; real prepare failures use status "error".
            const phantomPrepareDone =
              !event.runId &&
              (event.status === "finished" ||
                event.status === "completed" ||
                event.status === "success") &&
              (sendingRef.current.has(event.sessionId) ||
                busyIdsRef.current.has(event.sessionId));
            if (phantomPrepareDone) {
              markBusy(event.sessionId, true);
              return;
            }
            markBusy(event.sessionId, false);
            clearSending(event.sessionId);
            if (event.title) {
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === event.sessionId
                    ? { ...s, title: event.title || s.title, busy: false }
                    : s,
                ),
              );
            }
            void refreshSessions();
            notifyAgentDone({
              title: event.title,
              status: event.status,
              sessionId: event.sessionId,
              viewingThisChat: event.sessionId === activeIdRef.current,
            });
          }
          if (event.type === "error" && event.sessionId) {
            markBusy(event.sessionId, false);
            clearSending(event.sessionId);
          }

          if (event.type === "ask_question" && event.sessionId) {
            if (event.status === "pending") {
              setAskPendingIds((prev) => {
                if (prev.has(event.sessionId)) return prev;
                const next = new Set(prev);
                next.add(event.sessionId);
                return next;
              });
              // Keep card state even if a later filter races; active chat renders it.
              if (event.sessionId === activeIdRef.current) {
                setPendingQuestions((prev) => {
                  const without = prev.filter((item) => item.callId !== event.callId);
                  return [
                    ...without,
                    {
                      callId: event.callId,
                      toolCallId: event.toolCallId,
                      title: event.title,
                      questions: event.questions,
                    },
                  ];
                });
              }
              const chatTitle =
                sessionsRef.current.find((s) => s.id === event.sessionId)?.title ||
                event.title;
              notifyAskWaiting({
                sessionId: event.sessionId,
                chatTitle,
                questionTitle: event.title || event.questions[0]?.prompt,
                viewingThisChat: event.sessionId === activeIdRef.current,
              });
            } else {
              setAskPendingIds((prev) => {
                if (!prev.has(event.sessionId)) return prev;
                const next = new Set(prev);
                next.delete(event.sessionId);
                return next;
              });
              if (event.sessionId === activeIdRef.current) {
                setPendingQuestions((prev) =>
                  prev.filter((item) => item.callId !== event.callId),
                );
                setAskSubmittingId((prev) => (prev === event.callId ? null : prev));
              }
            }
          }

          if (event.type === "child_agent") {
            if (event.status === "running") {
              markBusy(event.childSessionId, true);
            } else {
              markBusy(event.childSessionId, false);
            }
            setSessions((prev) => {
              const childIdx = prev.findIndex((s) => s.id === event.childSessionId);
              if (childIdx >= 0) {
                const child = prev[childIdx]!;
                if (
                  child.childStatus === event.status &&
                  (!event.title || event.title === child.title)
                ) {
                  return prev;
                }
                const next = [...prev];
                next[childIdx] = {
                  ...child,
                  childStatus: event.status,
                  title: event.title || child.title,
                  agentBranch: event.branch || child.agentBranch,
                  updatedAt: Date.now(),
                };
                return next;
              }
              const parent = prev.find((s) => s.id === event.sessionId);
              if (!parent) return prev;
              return [
                ...prev,
                {
                  id: event.childSessionId,
                  agentId: parent.agentId,
                  workspace: parent.workspace,
                  model: parent.model,
                  title: event.title || "Sub-agent",
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  messageCount: 0,
                  busy: event.status === "running",
                  parentSessionId: event.sessionId,
                  projectWorkspace: parent.projectWorkspace || parent.workspace,
                  agentBranch: event.branch,
                  childStatus: event.status,
                },
              ];
            });
            void refreshSessions();
          }

          if ("sessionId" in event && event.sessionId && event.sessionId !== activeIdRef.current) {
            if (event.type === "done" || event.type === "child_agent") {
              /* title/busy / children already handled above */
            }
            return;
          }

          switch (event.type) {
            case "assistant_delta":
              setStreamingText((prev) => prev + event.text);
              break;
            case "assistant_clear":
              setStreamingText("");
              break;
            case "assistant_commit":
              setStreamingText("");
              setMessages((prev) => {
                if (prev.some((m) => m.id === event.id)) return prev;
                return [
                  ...prev,
                  {
                    id: event.id,
                    role: "assistant",
                    content: event.text,
                    toolName: event.toolName,
                    mode: event.toolName === "createPlan" ? "plan" : undefined,
                    createdAt: Date.now(),
                    durationMs: event.durationMs,
                  },
                ];
              });
              break;
            case "user_message":
              setMessages((prev) => {
                const msg = event.message;
                // Drop only the first matching optimistic bubble (queue may have duplicates).
                const localIdx = prev.findIndex(
                  (m) =>
                    String(m.id).startsWith("local-") &&
                    matchesOptimisticUser(m, msg),
                );
                const withoutLocal =
                  localIdx >= 0
                    ? [...prev.slice(0, localIdx), ...prev.slice(localIdx + 1)]
                    : prev;
                if (withoutLocal.some((m) => m.id === msg.id)) return withoutLocal;
                return [...withoutLocal, msg];
              });
              break;
            case "queue_cancelled":
              setMessages((prev) =>
                prev.filter((m) => m.id !== event.clientMessageId),
              );
              break;
            case "activity":
              if (event.id === "working" || event.id === "planning") {
                setActivities((prev) => {
                  if (event.status === "running") {
                    const idx = prev.findIndex(
                      (item) => item.id === "working" || item.id === "planning",
                    );
                    const next: LiveActivity = {
                      ...event,
                      id: "planning",
                      label: event.label || "Planning next moves",
                      startedAt:
                        idx >= 0 ? prev[idx]!.startedAt ?? Date.now() : Date.now(),
                    };
                    if (idx >= 0) {
                      const copy = [...prev];
                      copy[idx] = { ...copy[idx]!, ...next };
                      return copy;
                    }
                    return [
                      ...prev.filter(
                        (item) => item.id !== "working" && item.id !== "planning",
                      ),
                      next,
                    ];
                  }
                  return prev.filter(
                    (item) => item.id !== "working" && item.id !== "planning",
                  );
                });
                break;
              }
              setActivities((prev) => {
                const withoutPlanning = prev.filter(
                  (item) => item.id !== "working" && item.id !== "planning",
                );
                const idx = withoutPlanning.findIndex((item) => item.id === event.id);
                const prevItem = idx >= 0 ? withoutPlanning[idx] : undefined;
                const startedAt =
                  event.status === "running"
                    ? prevItem?.startedAt ?? Date.now()
                    : prevItem?.startedAt;
                const durationMs =
                  typeof event.durationMs === "number"
                    ? event.durationMs
                    : prevItem?.durationMs != null
                      ? prevItem.durationMs
                      : event.status !== "running" && typeof startedAt === "number"
                        ? Math.max(0, Date.now() - startedAt)
                        : undefined;
                const next: LiveActivity = {
                  ...event,
                  // Don't wipe streamed thinking text when a later event omits detail.
                  detail: event.detail ?? prevItem?.detail,
                  startedAt,
                  durationMs,
                };
                if (idx >= 0) {
                  const copy = [...withoutPlanning];
                  copy[idx] = { ...copy[idx]!, ...next };
                  return copy;
                }
                return [...withoutPlanning, next];
              });
              const askKey = `${event.toolName || ""} ${event.label || ""} ${event.detail || ""}`
                .toLowerCase()
                .replace(/[_-]/g, "");
              const isAskActivity =
                askKey.includes("askuser") ||
                askKey.includes("askquestion") ||
                (/\bmcp\b/.test(askKey) && askKey.includes("ask"));
              if (
                event.id !== "working" &&
                event.id !== "planning" &&
                (event.status === "completed" ||
                  event.status === "error" ||
                  (event.status === "running" && isAskActivity))
              ) {
                setMessages((prev) => {
                  const existingIdx = prev.findIndex(
                    (message) =>
                      message.role === "activity" && message.activityId === event.id,
                  );
                  const existing = existingIdx >= 0 ? prev[existingIdx] : undefined;
                  const row: ChatMessage = {
                    id: existing?.id ?? `activity-${event.id}`,
                    role: "activity",
                    content: event.label,
                    activityId: event.id,
                    activityKind: event.kind,
                    activityStatus: event.status,
                    durationMs: event.durationMs ?? existing?.durationMs,
                    detail: event.detail ?? existing?.detail,
                    toolName: event.toolName ?? existing?.toolName,
                    filePath: event.filePath ?? existing?.filePath,
                    linesAdded: event.linesAdded ?? existing?.linesAdded,
                    linesRemoved: event.linesRemoved ?? existing?.linesRemoved,
                    linesCreated: event.linesCreated ?? existing?.linesCreated,
                    createdAt: existing?.createdAt ?? Date.now(),
                  };
                  if (existingIdx >= 0) {
                    const copy = [...prev];
                    copy[existingIdx] = { ...copy[existingIdx], ...row };
                    return copy;
                  }
                  return [...prev, row];
                });
              }
              // Tool row can appear before ask_question WS — pull cards from HTTP.
              if (event.status === "running" && isAskActivity) {
                const id = activeIdRef.current;
                if (id) {
                  window.setTimeout(() => pullPendingAskQuestions(id), 50);
                  window.setTimeout(() => pullPendingAskQuestions(id), 400);
                }
              }
              break;
            case "status":
              if (event.status === "connected") setError(null);
              break;
            case "session_mode":
              if (
                event.sessionId === activeIdRef.current &&
                (event.mode === "plan" || event.mode === "agent")
              ) {
                setMode(event.mode);
                storeMode(event.mode);
              }
              void refreshSessions();
              break;
            case "board_updated":
              setBoardRefreshKey((k) => k + 1);
              break;
            case "error":
              setError(event.message);
              break;
            case "rolled_back":
              markBusy(event.sessionId, false);
              clearSending(event.sessionId);
              setStreamingText("");
              setActivities([]);
              setPendingQuestions([]);
              setAskSubmittingId(null);
              setMessages(event.messages);
              setHasMoreOlder(Boolean(event.hasMoreOlder));
              ingestRestoredPrompt(event.restoredPrompt);
              void refreshSessions();
              break;
            case "usage":
              setLastUsage(event.usage);
              setLastContext(event.context ?? null);
              break;
            case "ask_question":
              if (event.status === "pending") {
                setPendingQuestions((prev) => {
                  const without = prev.filter((item) => item.callId !== event.callId);
                  return [
                    ...without,
                    {
                      callId: event.callId,
                      toolCallId: event.toolCallId,
                      title: event.title,
                      questions: event.questions,
                    },
                  ];
                });
              } else {
                setPendingQuestions((prev) =>
                  prev.filter((item) => item.callId !== event.callId),
                );
                setAskSubmittingId((prev) => (prev === event.callId ? null : prev));
                // Freeze Ask user activity timer when the card closes.
                const askIds = new Set(
                  [event.callId, event.toolCallId].filter(Boolean) as string[],
                );
                setMessages((prev) => {
                  let changed = false;
                  const patched = prev.map((message) => {
                    if (
                      message.role !== "activity" ||
                      message.activityStatus !== "running"
                    ) {
                      return message;
                    }
                    const id = message.activityId || message.id;
                    const key = `${message.toolName || ""} ${message.content || ""}`
                      .toLowerCase()
                      .replace(/[_-]/g, "");
                    const isAsk =
                      askIds.has(id) ||
                      key.includes("askuser") ||
                      key.includes("askquestion");
                    if (!isAsk) return message;
                    changed = true;
                    const durationMs =
                      typeof message.durationMs === "number"
                        ? message.durationMs
                        : Math.max(0, Date.now() - message.createdAt);
                    return {
                      ...message,
                      activityStatus: "completed" as const,
                      durationMs,
                    };
                  });
                  if (event.status === "answered" || event.status === "skipped") {
                    const questionStatus = event.status;
                    const base = changed ? patched : prev;
                    if (base.some((m) => m.questionCallId === event.callId)) {
                      return changed ? patched : prev;
                    }
                    return insertQuestionAfterActivity(
                      base,
                      {
                        id: `question-${event.callId}`,
                        role: "question",
                        content:
                          questionStatus === "skipped"
                            ? "Skipped questions"
                            : event.title || "Answered questions",
                        createdAt: Date.now(),
                        questionTitle: event.title,
                        questionItems: event.questions,
                        questionStatus,
                        questionAnswers: event.answers,
                        questionCallId: event.callId,
                      },
                      event.callId,
                      event.toolCallId,
                    );
                  }
                  return changed ? patched : prev;
                });
                setActivities((prev) =>
                  prev.map((item) => {
                    const key = `${item.toolName || ""} ${item.label || ""}`
                      .toLowerCase()
                      .replace(/[_-]/g, "");
                    const isAsk =
                      askIds.has(item.id) ||
                      key.includes("askuser") ||
                      key.includes("askquestion");
                    if (!isAsk || item.status !== "running") return item;
                    return {
                      ...item,
                      status: "completed" as const,
                      durationMs:
                        item.durationMs ??
                        (typeof item.startedAt === "number"
                          ? Math.max(0, Date.now() - item.startedAt)
                          : undefined),
                    };
                  }),
                );
              }
              break;
            case "media":
              // Server also sends assistant_commit with the same path; ignore here.
              break;
            case "done":
              setStreamingText("");
              setActivities([]);
              // Keep AskQuestion cards if the user still needs to answer
              // (e.g. ask_user MCP / late WS events). Cleared on answered/skipped.
              setAskSubmittingId(null);
              if (event.usage) setLastUsage(event.usage);
              if (event.context) setLastContext(event.context);
              void refreshActive();
              // Re-pull pending asks — done can race ahead of ask_question WS.
              {
                const id = activeIdRef.current;
                if (id) pullPendingAskQuestions(id);
              }
              break;
          }
        },
        (state) => {
          if (state === "reconnecting") {
            if (deployScheduledRef.current || hasReloadAfterDeploy()) {
              markReloadAfterDeploy();
              deployOfflineSeenRef.current = true;
            }
            setError("Connection lost — reconnecting…");
          } else if (state === "open") {
            if (hasReloadAfterDeploy() && deployOfflineSeenRef.current) {
              hardReloadApp();
              return;
            }
            setError((prev) =>
              prev?.startsWith("Connection lost") ||
              prev?.includes("WebSocket") ||
              prev?.includes("restarting")
                ? null
                : prev,
            );
            void resyncFromServer();
          }
        },
      );
      socketRef.current = handle;
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      socketRef.current = null;
      handle?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  async function refreshSessions(): Promise<SessionSummary[] | null> {
    try {
      const projectCount = Math.max(PROJECT_PAGE_SIZE, projectItemsRef.current.length);
      const sessionsLimit = Math.max(
        SESSIONS_PER_PROJECT,
        ...projectItemsRef.current.map((p) => p.sessions.length),
      );
      const { projects, hasMore } = await listProjects(auth, {
        limit: projectCount,
        sessionsLimit,
      });
      setProjectItems(projects);
      projectItemsRef.current = projects;
      setHasMoreProjects(hasMore);
      const items = flattenProjects(projects);
      setSessions(items);
      sessionsRef.current = items;
      setBusyIds((prev) => {
        const next = new Set(prev);
        for (const item of items) {
          if (item.busy) next.add(item.id);
          else {
            sendingRef.current.delete(item.id);
            next.delete(item.id);
          }
        }
        for (const id of [...next]) {
          if (!items.some((item) => item.id === id) && !sendingRef.current.has(id)) {
            next.delete(id);
          }
        }
        busyIdsRef.current = next;
        return next;
      });
      return items;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function loadMoreProjects() {
    if (loadingMoreProjects || !hasMoreProjects) return;
    const last = projectItems[projectItems.length - 1];
    if (!last) return;
    setLoadingMoreProjects(true);
    try {
      const { projects, hasMore } = await listProjects(auth, {
        limit: PROJECT_PAGE_SIZE,
        beforeUpdatedAt: last.updatedAt,
        sessionsLimit: SESSIONS_PER_PROJECT,
      });
      setProjectItems((prev) => {
        const seen = new Set(prev.map((p) => p.key));
        return [...prev, ...projects.filter((p) => !seen.has(p.key))];
      });
      setHasMoreProjects(hasMore);
      setSessions((prev) => mergeSessionLists(prev, flattenProjects(projects)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMoreProjects(false);
    }
  }

  async function loadMoreProjectSessions(workspacePath: string, key: string) {
    if (loadingSessionsKey) return;
    const project = projectItems.find((p) => p.key === key);
    const last = project?.sessions[project.sessions.length - 1];
    if (!project || !last) return;
    setLoadingSessionsKey(key);
    try {
      const { sessions: more, children, hasMore } = await listProjectSessions(auth, {
        workspace: workspacePath,
        limit: SESSIONS_PER_PROJECT,
        beforeUpdatedAt: last.updatedAt,
      });
      setProjectItems((prev) =>
        prev.map((p) => {
          if (p.key !== key) return p;
          const seen = new Set(p.sessions.map((s) => s.id));
          const sessions = [...p.sessions, ...more.filter((s) => !seen.has(s.id))];
          const childSeen = new Set(p.children.map((s) => s.id));
          const nextChildren = [
            ...p.children,
            ...children.filter((s) => !childSeen.has(s.id)),
          ];
          return {
            ...p,
            sessions,
            children: nextChildren,
            hasMoreSessions: hasMore,
            totalSessions: Math.max(p.totalSessions, sessions.length + (hasMore ? 1 : 0)),
          };
        }),
      );
      setSessions((prev) => mergeSessionLists(prev, [...more, ...children]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSessionsKey(null);
    }
  }

  async function refreshActive() {
    if (!activeIdRef.current) return;
    try {
      const detail = await getSession(auth, activeIdRef.current, {
        limit: MESSAGE_PAGE_SIZE,
      });
      setMessages((prev) => {
        const merged = mergeTailRefresh(detail.messages, prev);
        setHasMoreOlder(
          Boolean(detail.hasMoreOlder) ||
            (merged.length > detail.messages.length &&
              merged[0]?.id !== detail.messages[0]?.id),
        );
        return merged;
      });
    } catch {
      /* ignore race */
    }
  }

  async function loadOlderMessages() {
    const id = activeIdRef.current;
    if (!id || loadingOlder || !hasMoreOlder) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const detail = await getSession(auth, id, {
        limit: MESSAGE_PAGE_SIZE,
        before: oldest.id,
      });
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const older = detail.messages.filter((m) => !seen.has(m.id));
        return [...older, ...prev];
      });
      setHasMoreOlder(Boolean(detail.hasMoreOlder));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function openSession(id: string) {
    setActiveId(id);
    setShowNew(false);
    setSidebarOpen(false);
    setHeaderVisible(true);
    setMessages([]);
    setHasMoreOlder(false);
    setChatLoading(true);
    setStreamingText("");
    setActivities([]);
    setPendingQuestions([]);
    setAskSubmittingId(null);
    setLastUsage(null);
    setLastContext(null);
    setError(null);
    try {
      localStorage.setItem(SESSION_KEY, id);
    } catch {
      /* ignore */
    }
    try {
      const detail = await getSession(auth, id, { limit: MESSAGE_PAGE_SIZE });
      setMessages(detail.messages);
      setHasMoreOlder(Boolean(detail.hasMoreOlder));
      if (detail.context) {
        setLastContext(detail.context);
        setLastUsage(detail.usage ?? latestContextFromMessages(detail.messages)?.usage ?? null);
      } else {
        const latest = latestContextFromMessages(detail.messages);
        setLastUsage(latest?.usage ?? null);
        setLastContext(latest?.context ?? null);
      }
      setWorkspace(detail.workspace);
      if (detail.mode === "plan" || detail.mode === "agent") {
        setMode(detail.mode);
        storeMode(detail.mode);
      }
      syncBusyFromServer(id, Boolean(detail.busy));
      try {
        const pending = await listPendingAskQuestions(auth, id);
        applyPendingFromServer(id, pending.pending);
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (isMissingSessionError(err)) {
        clearStoredSessionId();
        const fallback = sessionsRef.current.find((s) => s.id !== id);
        if (fallback) {
          await openSession(fallback.id);
          return;
        }
        setActiveId(null);
        setShowNew(true);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChatLoading(false);
    }
  }

  useEffect(() => {
    function onOpenSession(event: Event) {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;
      void openSession(sessionId);
    }
    window.addEventListener("webcli:open-session", onOpenSession);
    return () => window.removeEventListener("webcli:open-session", onOpenSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, accessToken]);

  async function handleCreate(workspaceOverride?: string) {
    const ws = (workspaceOverride ?? workspace).trim();
    if (!ws) {
      setShowNew(true);
      setError("Choose a workspace folder first");
      return;
    }
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await createSession(auth, {
        workspace: ws,
        model,
        mode,
      });
      setWorkspace(ws);
      setSessions((prev) => [session, ...prev]);
      setHasMoreOlder(false);
      await refreshSessions();
      setActiveId(session.id);
      try {
        localStorage.setItem(SESSION_KEY, session.id);
      } catch {
        /* ignore */
      }
      setMessages([]);
      setActivities([]);
      setPendingQuestions([]);
      setAskSubmittingId(null);
      setStreamingText("");
      setLastUsage(null);
      setLastContext(null);
      setShowNew(false);
      setSidebarOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    const title = sessions.find((s) => s.id === id)?.title || "this chat";
    const ok = window.confirm(`Delete «${title}»? This cannot be undone.`);
    if (!ok) return;
    try {
      await deleteSession(auth, id);
      markBusy(id, false);
      clearSending(id);
      setAskPendingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setProjectItems((prev) =>
        prev
          .map((p) => ({
            ...p,
            sessions: p.sessions.filter((s) => s.id !== id),
            children: p.children.filter((s) => s.id !== id),
            totalSessions: Math.max(
              0,
              p.totalSessions - (p.sessions.some((s) => s.id === id) ? 1 : 0),
            ),
          }))
          .filter((p) => p.sessions.length > 0 || p.children.length > 0),
      );
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setHasMoreOlder(false);
        setLastUsage(null);
        setLastContext(null);
        setShowNew(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRename(id: string, title: string) {
    try {
      const updated = await updateSession(auth, id, { title });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: updated.title } : s)),
      );
      setProjectItems((prev) =>
        prev.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) =>
            s.id === id ? { ...s, title: updated.title } : s,
          ),
          children: p.children.map((s) =>
            s.id === id ? { ...s, title: updated.title } : s,
          ),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function promptRenameActive() {
    if (!activeId) return;
    const current = sessions.find((s) => s.id === activeId)?.title || "";
    const next = window.prompt("Rename chat", current);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    void handleRename(activeId, trimmed);
  }

  async function handleSend(
    text: string,
    images: SendImagePayload[] = [],
    opts?: { mode?: "agent" | "plan" },
  ) {
    if (!activeId) return;
    const sendMode = opts?.mode ?? mode;
    const sessionId = activeId;
    const alreadyBusy = busyIdsRef.current.has(sessionId);
    // Only block double-tap while starting an idle run — allow queue while busy.
    if (!alreadyBusy && sendingRef.current.has(sessionId)) return;

    if (!alreadyBusy) {
      sendingRef.current.add(sessionId);
      markBusy(sessionId, true);
      setError(null);
      setStreamingText("");
      setPendingQuestions([]);
      setAskSubmittingId(null);
      setActivities([
        {
          type: "activity",
          sessionId,
          id: "planning",
          kind: "thinking",
          label: "Planning next moves",
          status: "running",
          startedAt: Date.now(),
        },
      ]);
    } else {
      setError(null);
      markBusy(sessionId, true);
    }

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayText = text.trim() || (images.length > 0 ? "(image)" : "");
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        role: "user",
        content: displayText,
        mode: sendMode,
        queued: alreadyBusy,
        images: images.map((img) => ({
          mimeType: img.mimeType,
          dataUrl: `data:${img.mimeType};base64,${img.data}`,
        })),
        createdAt: Date.now(),
      },
    ]);
    try {
      const result = await sendMessage(auth, sessionId, text, {
        model,
        mode: sendMode,
        images,
        clientMessageId: localId,
      });
      if (result.queued) {
        setMessages((prev) =>
          prev.map((m) => (m.id === localId ? { ...m, queued: true } : m)),
        );
      }
      setComposerDraft("");
    } catch (err) {
      if (!alreadyBusy) {
        clearSending(sessionId);
        markBusy(sessionId, false);
        setActivities([]);
      }
      setMessages((prev) => prev.filter((m) => m.id !== localId));
      setComposerDraft(text);
      setComposerDraftKey((k) => k + 1);
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function handleCancelQueued(messageId: string) {
    if (!activeId) return;
    setError(null);
    try {
      await cancelQueuedMessage(auth, activeId, { clientMessageId: messageId });
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch (err) {
      // Already started or missing — drop local bubble anyway if still queued.
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop() {
    if (!activeId) return;
    try {
      await cancelRun(auth, activeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAnswerQuestion(callId: string, answers: AskQuestionAnswer[]) {
    if (!activeId) return;
    const toolCallId =
      pendingQuestions.find((q) => q.callId === callId)?.toolCallId || callId;
    setAskSubmittingId(callId);
    setError(null);
    try {
      const result = await answerAskQuestion(auth, activeId, callId, {
        outcome: "answered",
        answers,
      });
      setPendingQuestions((prev) => {
        const next = prev.filter((item) => item.callId !== callId);
        if (next.length === 0) {
          setAskPendingIds((ids) => {
            if (!ids.has(activeId)) return ids;
            const copy = new Set(ids);
            copy.delete(activeId);
            return copy;
          });
        }
        return next;
      });
      setMessages((prev) => {
        if (prev.some((m) => m.questionCallId === callId || m.id === result.message.id)) {
          return prev;
        }
        return insertQuestionAfterActivity(prev, result.message, callId, toolCallId);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAskSubmittingId((prev) => (prev === callId ? null : prev));
    }
  }

  async function handleSkipQuestion(callId: string) {
    if (!activeId) return;
    const toolCallId =
      pendingQuestions.find((q) => q.callId === callId)?.toolCallId || callId;
    setAskSubmittingId(callId);
    setError(null);
    try {
      const result = await answerAskQuestion(auth, activeId, callId, {
        outcome: "skipped",
        reason: "Questions skipped by the user",
      });
      setPendingQuestions((prev) => {
        const next = prev.filter((item) => item.callId !== callId);
        if (next.length === 0) {
          setAskPendingIds((ids) => {
            if (!ids.has(activeId)) return ids;
            const copy = new Set(ids);
            copy.delete(activeId);
            return copy;
          });
        }
        return next;
      });
      setMessages((prev) => {
        if (prev.some((m) => m.questionCallId === callId || m.id === result.message.id)) {
          return prev;
        }
        return insertQuestionAfterActivity(prev, result.message, callId, toolCallId);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAskSubmittingId((prev) => (prev === callId ? null : prev));
    }
  }

  function handleModeChange(next: "agent" | "plan") {
    setMode(next);
    storeMode(next);
    if (activeId) {
      void updateSessionMode(auth, activeId, next).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }
  }

  /**
   * Put restore text into the composer once.
   * Rollback is delivered via both HTTP and WS; on phone WS can lag by seconds
   * and used to re-paste over the user's edits — dedupe by prompt token only.
   * Do not clear composerDraft in a microtask: React may commit draft="" before
   * Composer applies the inject, and the field stays empty.
   */
  function ingestRestoredPrompt(prompt: string | undefined) {
    if (!prompt) return;
    if (rollbackDraftTokenRef.current === prompt) return;
    rollbackDraftTokenRef.current = prompt;
    setComposerDraft(prompt);
    setComposerDraftKey((k) => k + 1);
  }

  async function handleRollback(messageId: string) {
    if (!activeId || busy) return;
    const target = messages.find((m) => m.id === messageId);
    const hasCheckpoint = Boolean(target?.checkpointSha);
    const ok = window.confirm(
      hasCheckpoint
        ? "Restore files and chat to this message? Later messages will be removed, and its text will go back into the input."
        : "Restore chat to this message? Later messages will be removed and its text will go back into the input. Files will not change (no checkpoint for this message).",
    );
    if (!ok) return;
    setError(null);
    // Allow re-applying the same prompt on a fresh Restore click.
    rollbackDraftTokenRef.current = null;
    try {
      const result = await rollbackMessage(auth, activeId, messageId);
      setMessages(result.messages);
      setStreamingText("");
      setActivities([]);
      setPendingQuestions([]);
      setAskSubmittingId(null);
      ingestRestoredPrompt(result.restoredPrompt);
      await refreshSessions();
      if (hasCheckpoint && !result.filesRestored) {
        setError(
          result.filesError
            ? `Chat restored, but files were not: ${result.filesError}`
            : "Chat restored, but files were not restored.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleImplementPlan() {
    handleModeChange("agent");
    void handleSend("Implement the plan.", [], { mode: "agent" });
  }

  function handleNewChat(projectWorkspace?: string) {
    if (projectWorkspace?.trim()) {
      void handleCreate(projectWorkspace);
      return;
    }
    setShowNew(true);
    setActiveId(null);
    setMessages([]);
    setChatLoading(false);
    setActivities([]);
    setStreamingText("");
    setLastUsage(null);
    setLastContext(null);
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen(false);
    }
  }

  function handleModelChange(next: string) {
    setModel(next);
    storeModel(next);
  }

  async function handleEnableNotifications() {
    setNotifyBusy(true);
    setError(null);
    try {
      const result = await enablePushNotifications(auth);
      if (result.ok) {
        setShowNotifyBanner(false);
      } else {
        setError(result.reason || "Could not enable notifications");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotifyBusy(false);
    }
  }

  function saveToken() {
    storeToken(tokenDraft.trim());
    setAccessToken(tokenDraft.trim());
  }

  if (!authenticated) {
    return (
      <div className="flex min-h-full items-center justify-center bg-surface p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-panel p-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
              WebCLI
              {isStand ? (
                <span className="ml-2 rounded border border-amber-700/60 bg-amber-950/50 px-1.5 py-0.5 text-[10px] tracking-wider text-amber-200">
                  stand
                </span>
              ) : null}
            </p>
            <h1 className="mt-1 text-xl font-semibold text-ink">Access token</h1>
            <p className="mt-2 text-sm text-muted">
              Enter the same <code className="font-mono">ACCESS_TOKEN</code> as in your server{" "}
              <code className="font-mono">.env</code>.
              {isStand ? (
                <>
                  {" "}
                  This is the <strong className="font-medium text-ink">test stand</strong> (does not
                  touch the release instance).
                </>
              ) : null}
            </p>
          </div>
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
            placeholder="ACCESS_TOKEN"
          />
          <button
            type="button"
            onClick={saveToken}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (bootLoading) {
    return <BootSplash />;
  }

  return (
    <div className="flex h-full bg-surface text-ink">
      {/*
        Mobile: fixed-width drawer slides via transform only (no width squash).
        Desktop: clips a fixed-width panel by animating shell width 0 ↔ 18rem.
      */}
      <div
        className={`sidebar-shell fixed inset-y-0 left-0 z-30 overflow-hidden md:static md:z-auto ${
          sidebarOpen
            ? "w-[min(18rem,85vw)] translate-x-0 md:w-72"
            : "w-[min(18rem,85vw)] -translate-x-full md:w-0 md:translate-x-0"
        }`}
        aria-hidden={!sidebarOpen}
      >
        <div className="h-full w-[min(18rem,85vw)] md:w-72">
          <SessionList
            projects={projectItems}
            hasMoreProjects={hasMoreProjects}
            loadingMoreProjects={loadingMoreProjects}
            onLoadMoreProjects={() => void loadMoreProjects()}
            onLoadMoreSessions={(ws, key) => void loadMoreProjectSessions(ws, key)}
            loadingSessionsKey={loadingSessionsKey}
            activeId={activeId}
            busyIds={busyIds}
            askPendingIds={askPendingIds}
            onSelect={(id) => {
              void openSession(id);
              if (window.matchMedia("(max-width: 767px)").matches) {
                setSidebarOpen(false);
              }
            }}
            onNew={handleNewChat}
            onDelete={(id) => void handleDelete(id)}
            onRename={(id, title) => void handleRename(id, title)}
          />
        </div>
      </div>

      <button
        type="button"
        className={`sidebar-backdrop fixed inset-0 z-20 bg-black/45 md:hidden ${
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-label="Close sidebar"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {isStand ? (
          <div className="bg-amber-950/40 px-4 py-1 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">
            test stand · :5174 → api :8788 · release stays on :8787
          </div>
        ) : null}

        <DeployBanner
          auth={auth}
          status={deployStatus}
          onChange={setDeployStatus}
        />

        {error ? (
          <div className="bg-red-950/40 px-4 py-2 text-sm text-red-200">{error}</div>
        ) : null}

        {showNotifyBanner ? (
          <div className="flex items-start gap-3 bg-elevated px-4 py-2.5 text-sm text-ink">
            <p className="min-w-0 flex-1 text-muted">
              Enable notifications so the phone alerts you when the agent finishes. On iPhone: add
              this site to the Home Screen first, then tap Enable.
            </p>
            <button
              type="button"
              disabled={notifyBusy}
              onClick={() => void handleEnableNotifications()}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-[var(--color-accent-ink)] disabled:opacity-50"
            >
              {notifyBusy ? "…" : "Enable"}
            </button>
            <button
              type="button"
              onClick={() => setShowNotifyBanner(false)}
              className="shrink-0 text-xs text-muted hover:text-ink"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ) : null}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <AppHeader
            visible={headerVisible || showNew || !activeId}
            title={
              activeId
                ? sessions.find((s) => s.id === activeId)?.title
                : showNew
                  ? "New chat"
                  : null
            }
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onNewChat={() => {
              // Same project as the active chat — skip the workspace picker.
              if (workspace.trim()) {
                void handleCreate(workspace);
                return;
              }
              handleNewChat();
            }}
            onOpenBoard={activeId ? () => setBoardOpen(true) : undefined}
            onOpenSettings={() => setToolsOpen(true)}
            onRenameTitle={activeId ? promptRenameActive : undefined}
          />

          {showNew || !activeId ? (
            <div className="flex flex-1 items-start justify-center p-4 pt-14">
              <div className="w-full max-w-lg">
                <WorkspacePicker
                  auth={auth}
                  workspace={workspace}
                  onWorkspaceChange={setWorkspace}
                  onCreate={() => void handleCreate()}
                  busy={creating}
                />
              </div>
            </div>
          ) : chatLoading ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ChatSkeleton />
            </div>
          ) : (
            <>
              <Chat
                messages={messages}
                streamingText={streamingText}
                activities={activities}
                pendingQuestions={pendingQuestions}
                busy={busy}
                sessionId={activeId}
                auth={auth}
                askSubmittingId={askSubmittingId}
                hasMoreOlder={hasMoreOlder}
                loadingOlder={loadingOlder}
                onLoadOlder={() => loadOlderMessages()}
                onRollback={(messageId) => void handleRollback(messageId)}
                onCancelQueued={(messageId) => void handleCancelQueued(messageId)}
                onImplementPlan={handleImplementPlan}
                onAnswerQuestion={(callId, answers) =>
                  void handleAnswerQuestion(callId, answers)
                }
                onSkipQuestion={(callId) => void handleSkipQuestion(callId)}
                onScrollDirection={(direction) => {
                  setHeaderVisible(direction === "up");
                }}
              />
              <ChildAgentsStrip
                childrenAgents={childAgentsForActive}
                busyIds={busyIds}
                onSelect={(id) => void openSession(id)}
              />
              <Composer
                auth={auth}
                workspace={workspace}
                sessionId={activeId}
                disabled={false}
                busy={busy}
                model={model}
                models={models}
                modelsLoading={modelsLoading}
                mode={mode}
                draftText={composerDraft}
                draftKey={composerDraftKey}
                lastUsage={lastUsage}
                lastContext={lastContext}
                onModelChange={handleModelChange}
                onModeChange={handleModeChange}
                onStop={() => void handleStop()}
                onSend={(text, images) => handleSend(text, images)}
              />
            </>
          )}
        </div>
      </main>

      <SettingsPanel
        auth={auth}
        sessionId={activeId}
        workspace={workspace}
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        onImported={(id) => void openSession(id)}
        onError={(message) => setError(message)}
      />
      <BoardPanel
        auth={auth}
        workspace={projectWorkspace}
        open={boardOpen}
        refreshKey={boardRefreshKey}
        onClose={() => setBoardOpen(false)}
        onInsertToChat={(text) => {
          setComposerDraft((prev) => {
            const base = prev.trim();
            return base ? `${base} ${text}` : text;
          });
          setComposerDraftKey((k) => k + 1);
        }}
        onError={(message) => setError(message)}
      />
    </div>
  );
}
