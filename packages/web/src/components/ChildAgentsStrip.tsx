import type { ChildAgentStatus } from "../lib/api";

export type ChildAgentStripItem = {
  id: string;
  title: string;
  childStatus?: ChildAgentStatus;
  busy?: boolean;
};

type Props = {
  childrenAgents: ChildAgentStripItem[];
  busyIds?: ReadonlySet<string>;
  onSelect?: (id: string) => void;
};

function isChildBusy(
  child: ChildAgentStripItem,
  busyIds?: ReadonlySet<string>,
): boolean {
  return Boolean(child.busy) || Boolean(busyIds?.has(child.id));
}

function resolveStatus(
  child: ChildAgentStripItem,
  busyIds?: ReadonlySet<string>,
): ChildAgentStatus {
  if (isChildBusy(child, busyIds) || child.childStatus === "running") {
    return "running";
  }
  return child.childStatus ?? "running";
}

function statusLabel(status: ChildAgentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "merged":
      return "merged";
    case "conflict":
      return "conflict";
    case "error":
      return "error";
  }
}

function statusClass(status: ChildAgentStatus): string {
  switch (status) {
    case "running":
      return "bg-accent/20 text-accent";
    case "merged":
      return "bg-emerald-500/20 text-emerald-200";
    case "done":
      return "bg-accent/20 text-accent";
    case "conflict":
      return "bg-amber-500/20 text-amber-100";
    case "error":
      return "bg-red-500/20 text-red-200";
  }
}

function StatusBadge({ status }: { status: ChildAgentStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${statusClass(status)}`}
    >
      {status === "running" ? (
        <span className="relative inline-flex h-1.5 w-1.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-50" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      ) : null}
      {statusLabel(status)}
    </span>
  );
}

/**
 * Live strip of child sub-agents for the parent chat, shown above the composer
 * while any child is running/busy. Hidden when idle.
 */
export function ChildAgentsStrip({
  childrenAgents,
  busyIds,
  onSelect,
}: Props) {
  const hasActive = childrenAgents.some(
    (child) =>
      isChildBusy(child, busyIds) || child.childStatus === "running",
  );
  if (!hasActive) return null;

  // While any child is working, show the current wave (exclude already-merged).
  const visible = childrenAgents.filter((child) => {
    const status = resolveStatus(child, busyIds);
    return status !== "merged";
  });
  if (visible.length === 0) return null;

  return (
    <div
      className="shrink-0 border-t border-line/50 bg-panel/90 px-3 py-2 md:px-4"
      role="status"
      aria-live="polite"
      aria-label="Sub-agents working"
    >
      <div className="mx-auto w-full max-w-3xl">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
          Sub-agents
        </p>
        <ul className="flex flex-col gap-1">
          {visible.map((child) => {
            const status = resolveStatus(child, busyIds);
            const clickable = Boolean(onSelect);
            const rowClass =
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors " +
              (clickable
                ? "hover:bg-white/[0.04] active:bg-white/[0.06]"
                : "");

            const content = (
              <>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {child.title || "Sub-agent"}
                </span>
                <StatusBadge status={status} />
              </>
            );

            return (
              <li key={child.id}>
                {clickable ? (
                  <button
                    type="button"
                    className={rowClass}
                    onClick={() => onSelect?.(child.id)}
                    title={`Open ${child.title || "sub-agent"}`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={rowClass}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
