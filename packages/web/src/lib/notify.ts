import type { AuthMode } from "./api";

let pushActive = false;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

async function authFetch(auth: AuthMode, path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
}

export function pushNotificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export function isPushActive(): boolean {
  return pushActive;
}

/** Register SW + Web Push. Must run after a user gesture on many phones. */
export async function enablePushNotifications(auth: AuthMode): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (!pushNotificationsSupported()) {
    return {
      ok: false,
      reason:
        "Push is not supported in this browser. On iPhone: Share → Add to Home Screen, then open the app.",
    };
  }

  if (!window.isSecureContext) {
    return { ok: false, reason: "Notifications need HTTPS (use CloudPub URL)." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "Notification permission denied." };
  }

  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  const keyRes = await authFetch(auth, "/api/push/vapid-public-key");
  if (!keyRes.ok) {
    return { ok: false, reason: "Could not load push keys from server." };
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  const subRes = await authFetch(auth, "/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!subRes.ok) {
    const body = (await subRes.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: body.error || "Failed to save push subscription." };
  }

  pushActive = true;
  try {
    localStorage.setItem("webcli.pushEnabled", "1");
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/** Re-subscribe quietly if permission already granted. */
export async function resumePushNotifications(auth: AuthMode): Promise<boolean> {
  if (!pushNotificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;
  try {
    const result = await enablePushNotifications(auth);
    return result.ok;
  } catch {
    return false;
  }
}

export function shouldOfferPushEnable(): boolean {
  if (!pushNotificationsSupported()) {
    // Still show tip on iOS Safari before PWA install.
    return typeof window !== "undefined" && "Notification" in window
      ? Notification.permission !== "granted"
      : true;
  }
  if (Notification.permission === "denied") return false;
  if (Notification.permission === "granted") {
    try {
      return (
        localStorage.getItem("webcli.pushEnabled") !== "1" &&
        localStorage.getItem("cursor-cli.pushEnabled") !== "1"
      );
    } catch {
      return true;
    }
  }
  return true;
}

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new AudioCtx();
  }
  return sharedAudioCtx;
}

/** Browsers (esp. iOS) block audio until a user gesture — unlock once on tap/key. */
function unlockAudioContext(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
}

let audioUnlockBound = false;
function ensureAudioUnlockListeners(): void {
  if (audioUnlockBound || typeof window === "undefined") return;
  audioUnlockBound = true;
  const unlock = () => unlockAudioContext();
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock, { passive: true });
}

ensureAudioUnlockListeners();

/** Soft two-tone chime so completion is audible even while viewing the chat. */
function playDoneChime(ok: boolean): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    void ctx.resume().then(() => {
      const now = ctx.currentTime;
      const freqs = ok ? [880, 1175] : [440, 330];
      for (let i = 0; i < freqs.length; i += 1) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freqs[i]!;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02 + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22 + i * 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + 0.28 + i * 0.12);
      }
    });
  } catch {
    /* ignore */
  }
}

/** Notify when an agent finishes. Prefer local Notification while the app is open —
 * Web Push is often suppressed by the SW when any window is focused, which wrongly
 * hid "other chat finished" alerts. When the finished chat is already visible and
 * focused, play a chime instead of an OS toast. */
export function notifyAgentDone(input: {
  title?: string;
  status: string;
  sessionId?: string;
  /** True when the user is currently viewing the chat that just finished. */
  viewingThisChat: boolean;
}): void {
  if (typeof window === "undefined") return;

  const ok =
    input.status === "finished" ||
    input.status === "completed" ||
    input.status === "success";

  // Don't require hasFocus() — mobile PWAs often report unfocused while the chat
  // is on screen, which previously skipped both chime and OS sound.
  const lookingAtThisChat =
    input.viewingThisChat && document.visibilityState === "visible";

  if (lookingAtThisChat) {
    playDoneChime(ok);
    return;
  }

  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const title = input.title?.trim() || "WebCLI";
  try {
    const n = new Notification(ok ? "Agent finished" : "Agent error", {
      body: ok ? `«${title}» is ready` : `«${title}» ended with ${input.status}`,
      tag: `webcli-done-${input.sessionId || title}`,
    });
    n.onclick = () => {
      window.focus();
      if (input.sessionId) {
        window.dispatchEvent(
          new CustomEvent("webcli:open-session", { detail: { sessionId: input.sessionId } }),
        );
      }
      n.close();
    };
  } catch {
    /* ignore */
  }
}

/** Local toast when an ask_user card is waiting (app open / focused elsewhere). */
export function notifyAskWaiting(input: {
  sessionId: string;
  chatTitle?: string;
  questionTitle?: string;
  viewingThisChat: boolean;
}): void {
  if (typeof window === "undefined") return;

  const lookingAtThisChat =
    input.viewingThisChat && document.visibilityState === "visible";
  if (lookingAtThisChat) return;

  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const chat = input.chatTitle?.trim() || "Chat";
  const q = input.questionTitle?.trim();
  try {
    const n = new Notification("Question waiting", {
      body: q ? `«${chat}»: ${q}` : `«${chat}» needs your answer`,
      tag: `webcli-ask-${input.sessionId}`,
    });
    n.onclick = () => {
      window.focus();
      window.dispatchEvent(
        new CustomEvent("webcli:open-session", {
          detail: { sessionId: input.sessionId },
        }),
      );
      n.close();
    };
  } catch {
    /* ignore */
  }
}
