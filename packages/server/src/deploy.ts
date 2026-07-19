import { listSessions, type StreamEvent } from "./agent.js";

/** Wrapper restarts the release process when it sees this exit code. */
export const DEPLOY_RESTART_EXIT_CODE = 75;

export type DeployStatus = {
  scheduled: boolean;
  restartAt: number | null;
  forceAt: number | null;
  delayMinutes: number | null;
  busySessions: number;
  waitingForIdle: boolean;
  message: string | null;
};

type DeployState = {
  forceAt: number;
  timer: ReturnType<typeof setInterval> | null;
};

type DeployBroadcaster = (
  event: Extract<
    StreamEvent,
    { type: "deploy_scheduled" | "deploy_cancelled" | "deploy_restarting" }
  >,
) => void;

let state: DeployState | null = null;
let broadcaster: DeployBroadcaster | null = null;
let onRestart: (() => void) | null = null;

/** Cap how long we wait for idle before forcing restart. */
const MAX_WAIT_FOR_IDLE_MS = 30 * 60_000;
const POLL_MS = 1_000;

export function setDeployBroadcaster(fn: DeployBroadcaster): void {
  broadcaster = fn;
}

export function setDeployRestartHandler(fn: () => void): void {
  onRestart = fn;
}

function busyCount(): number {
  return listSessions().filter((s) => s.busy).length;
}

export function getDeployStatus(): DeployStatus {
  const busySessions = busyCount();
  if (!state) {
    return {
      scheduled: false,
      restartAt: null,
      forceAt: null,
      delayMinutes: null,
      busySessions,
      waitingForIdle: false,
      message: null,
    };
  }
  const waitingForIdle = busySessions > 0 && Date.now() < state.forceAt;
  return {
    scheduled: true,
    restartAt: Date.now(),
    forceAt: state.forceAt,
    delayMinutes: 0,
    busySessions,
    waitingForIdle,
    message: waitingForIdle
      ? `Waiting for ${busySessions} active run(s) to finish, then restarting…`
      : "Restarting release with the new build…",
  };
}

function clearTimer(): void {
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function tryRestart(): void {
  if (!state) return;
  const busy = busyCount();
  if (busy > 0 && Date.now() < state.forceAt) {
    broadcaster?.({
      type: "deploy_scheduled",
      restartAt: Date.now(),
      forceAt: state.forceAt,
      delayMinutes: 0,
      message: getDeployStatus().message ?? undefined,
    });
    return;
  }
  clearTimer();
  state = null;
  broadcaster?.({
    type: "deploy_restarting",
    message: "Restarting release…",
  });
  setTimeout(() => {
    onRestart?.();
  }, 400);
}

/** Call when a run finishes so restart can happen immediately on idle. */
export function notifyDeployIdleCheck(): void {
  if (state) tryRestart();
}

/**
 * Schedule a release restart as soon as no sessions are busy.
 * delayMinutes / delaySeconds are ignored (kept for API compat) — restart is idle-gated only.
 */
export function scheduleDeploy(_input?: {
  delayMinutes?: number;
  delaySeconds?: number;
}): DeployStatus {
  clearTimer();
  state = {
    forceAt: Date.now() + MAX_WAIT_FOR_IDLE_MS,
    timer: setInterval(() => tryRestart(), POLL_MS),
  };

  const status = getDeployStatus();
  broadcaster?.({
    type: "deploy_scheduled",
    restartAt: Date.now(),
    forceAt: state.forceAt,
    delayMinutes: 0,
    message: status.message ?? undefined,
  });

  tryRestart();
  return getDeployStatus();
}

export function cancelDeploy(): DeployStatus {
  if (!state) return getDeployStatus();
  clearTimer();
  state = null;
  broadcaster?.({
    type: "deploy_cancelled",
    message: "Release update cancelled.",
  });
  return getDeployStatus();
}
