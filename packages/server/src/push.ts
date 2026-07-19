import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import { APP_NAME, dataDir } from "./paths.js";

export type PushSubscriptionJSON = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type VapidKeys = {
  publicKey: string;
  privateKey: string;
};

function vapidFile(): string {
  return join(dataDir(), "vapid.json");
}

function subscriptionsFile(): string {
  return join(dataDir(), "push-subscriptions.json");
}

let vapidReady: Promise<VapidKeys> | null = null;
let subscriptions: PushSubscriptionJSON[] = [];
let subscriptionsLoaded = false;

async function ensureVapid(): Promise<VapidKeys> {
  if (!vapidReady) {
    vapidReady = (async () => {
      await mkdir(dataDir(), { recursive: true });
      try {
        const raw = await readFile(vapidFile(), "utf8");
        const parsed = JSON.parse(raw) as VapidKeys;
        if (parsed.publicKey && parsed.privateKey) {
          webpush.setVapidDetails(
            process.env.VAPID_SUBJECT?.trim() || "mailto:webcli@localhost",
            parsed.publicKey,
            parsed.privateKey,
          );
          return parsed;
        }
      } catch {
        /* generate below */
      }

      const generated = webpush.generateVAPIDKeys();
      const keys: VapidKeys = {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      };
      await writeFile(vapidFile(), JSON.stringify(keys, null, 2), "utf8");
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT?.trim() || "mailto:webcli@localhost",
        keys.publicKey,
        keys.privateKey,
      );
      return keys;
    })();
  }
  return vapidReady;
}

async function loadSubscriptions(): Promise<void> {
  if (subscriptionsLoaded) return;
  subscriptionsLoaded = true;
  try {
    const raw = await readFile(subscriptionsFile(), "utf8");
    const parsed = JSON.parse(raw) as { subscriptions?: PushSubscriptionJSON[] };
    subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
  } catch {
    subscriptions = [];
  }
}

async function saveSubscriptions(): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(
    subscriptionsFile(),
    JSON.stringify({ subscriptions }, null, 2),
    "utf8",
  );
}

export async function getVapidPublicKey(): Promise<string> {
  const keys = await ensureVapid();
  return keys.publicKey;
}

export async function savePushSubscription(
  sub: PushSubscriptionJSON,
): Promise<void> {
  await ensureVapid();
  await loadSubscriptions();
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  subscriptions = [
    sub,
    ...subscriptions.filter((item) => item.endpoint !== sub.endpoint),
  ];
  await saveSubscriptions();
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await loadSubscriptions();
  subscriptions = subscriptions.filter((item) => item.endpoint !== endpoint);
  await saveSubscriptions();
}

export async function notifyPush(input: {
  title: string;
  body: string;
  tag?: string;
  sessionId?: string;
}): Promise<void> {
  await ensureVapid();
  await loadSubscriptions();
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: input.title,
    body: input.body,
    tag: input.tag ?? `${APP_NAME.toLowerCase()}-done`,
    sessionId: input.sessionId,
  });

  const expired: string[] = [];
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          expired.push(sub.endpoint);
        } else {
          console.error("Push notify failed:", err);
        }
      }
    }),
  );

  if (expired.length > 0) {
    subscriptions = subscriptions.filter((item) => !expired.includes(item.endpoint));
    await saveSubscriptions();
  }
}

export async function notifyAgentFinished(input: {
  title: string;
  status: string;
  sessionId?: string;
}): Promise<void> {
  const ok =
    input.status === "finished" ||
    input.status === "completed" ||
    input.status === "success";
  const chat = input.title.trim() || "Chat";
  await notifyPush({
    title: ok ? "Agent finished" : "Agent error",
    body: ok ? `«${chat}» is ready` : `«${chat}» ended with ${input.status}`,
    tag: `${APP_NAME.toLowerCase()}-done-${input.sessionId || chat}`,
    sessionId: input.sessionId,
  });
}

export async function notifyAskWaiting(input: {
  sessionId: string;
  chatTitle?: string;
  questionTitle?: string;
}): Promise<void> {
  const chat = input.chatTitle?.trim() || "Chat";
  const q = input.questionTitle?.trim();
  await notifyPush({
    title: "Question waiting",
    body: q ? `«${chat}»: ${q}` : `«${chat}» needs your answer`,
    tag: `${APP_NAME.toLowerCase()}-ask-${input.sessionId}`,
    sessionId: input.sessionId,
  });
}
