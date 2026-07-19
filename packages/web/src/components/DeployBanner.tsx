import { useState } from "react";
import { cancelDeploy, type AuthMode, type DeployStatus } from "../lib/api";

type Props = {
  auth: AuthMode;
  status: DeployStatus | null;
  onChange: (status: DeployStatus | null) => void;
};

export function DeployBanner({ auth, status, onChange }: Props) {
  const [busy, setBusy] = useState(false);

  if (!status?.scheduled) return null;

  return (
    <div className="flex items-start gap-3 bg-amber-950/50 px-4 py-2.5 text-sm text-amber-100">
      <p className="min-w-0 flex-1">
        {status.message ||
          (status.waitingForIdle
            ? "Waiting for active runs, then restarting…"
            : "Restarting release with the new build…")}
      </p>
      <button
        type="button"
        disabled={busy || !status.waitingForIdle}
        onClick={() => {
          setBusy(true);
          void cancelDeploy(auth)
            .then((next) => onChange(next.scheduled ? next : null))
            .catch(() => onChange(null))
            .finally(() => setBusy(false));
        }}
        className="shrink-0 rounded-md border border-amber-700/60 bg-amber-950/40 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900/50 disabled:opacity-50"
      >
        {busy ? "…" : "Cancel"}
      </button>
    </div>
  );
}
