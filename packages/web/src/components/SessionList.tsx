import { useEffect, useMemo, useState } from "react";
import { MessageSquarePlus, Plus, Search, Trash2 } from "lucide-react";
import type { ChildAgentStatus } from "../lib/api";
import { formatRelativeShort } from "../lib/time";
import { iconProps } from "./icons";

type SessionItem = {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
  busy?: boolean;
  parentSessionId?: string;
  projectWorkspace?: string;
  childStatus?: ChildAgentStatus;
  agentBranch?: string;
  childSessionIds?: string[];
};

type Props = {
  sessions: SessionItem[];
  activeId: string | null;
  busyIds?: ReadonlySet<string>;
  askPendingIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onNew: (workspace?: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, title: string) => void;
};

function normalizeWorkspace(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function projectName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path || "Unknown";
}

type ProjectGroup = {
  key: string;
  workspace: string;
  name: string;
  /** Top-level sessions only (children nested via byParent). */
  sessions: SessionItem[];
  updatedAt: number;
  anyBusy: boolean;
  anyAsk: boolean;
};

function groupByProject(
  sessions: SessionItem[],
  busyIds?: ReadonlySet<string>,
  askPendingIds?: ReadonlySet<string>,
): { groups: ProjectGroup[]; childrenByParent: Map<string, SessionItem[]> } {
  const childrenByParent = new Map<string, SessionItem[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const list = childrenByParent.get(session.parentSessionId) ?? [];
    list.push(session);
    childrenByParent.set(session.parentSessionId, list);
  }
  for (const [, list] of childrenByParent) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const map = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    if (session.parentSessionId) continue; // nested under parent row
    const parentWs = session.projectWorkspace || session.workspace;
    const key = normalizeWorkspace(parentWs || "");
    const existing = map.get(key);
    const sessionBusy = Boolean(session.busy) || Boolean(busyIds?.has(session.id));
    const kids = childrenByParent.get(session.id) ?? [];
    const kidsBusy = kids.some((k) => k.busy || busyIds?.has(k.id));
    const sessionAsk = Boolean(askPendingIds?.has(session.id));
    const kidsAsk = kids.some((k) => askPendingIds?.has(k.id));
    if (existing) {
      existing.sessions.push(session);
      existing.updatedAt = Math.max(
        existing.updatedAt,
        session.updatedAt,
        ...kids.map((k) => k.updatedAt),
      );
      existing.anyBusy = existing.anyBusy || sessionBusy || kidsBusy;
      existing.anyAsk = existing.anyAsk || sessionAsk || kidsAsk;
    } else {
      map.set(key, {
        key,
        workspace: parentWs,
        name: projectName(parentWs),
        sessions: [session],
        updatedAt: Math.max(session.updatedAt, ...kids.map((k) => k.updatedAt)),
        anyBusy: sessionBusy || kidsBusy,
        anyAsk: sessionAsk || kidsAsk,
      });
    }
  }
  const groups = [...map.values()]
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { groups, childrenByParent };
}

function BusyDot({ title }: { title?: string }) {
  return (
    <span
      className="relative inline-flex h-1.5 w-1.5 shrink-0"
      title={title ?? "Agent is working"}
      aria-label={title ?? "Agent is working"}
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-50" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
    </span>
  );
}

function AskBadge() {
  return (
    <span
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/90 px-1 text-[9px] font-semibold text-black"
      title="Waiting for your answer"
      aria-label="Waiting for your answer"
    >
      ?
    </span>
  );
}

function ChildStatusBadge({ status }: { status?: ChildAgentStatus }) {
  if (!status || status === "running") return null;
  const label =
    status === "done"
      ? "done"
      : status === "merged"
        ? "merged"
        : status === "conflict"
          ? "conflict"
          : "error";
  const cls =
    status === "merged"
      ? "bg-emerald-500/20 text-emerald-200"
      : status === "done"
        ? "bg-accent/20 text-accent"
        : status === "conflict"
          ? "bg-amber-500/20 text-amber-100"
          : "bg-red-500/20 text-red-200";
  return (
    <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${cls}`}>
      {label}
    </span>
  );
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function SessionList({
  sessions,
  activeId,
  busyIds,
  askPendingIds,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: Props) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const now = useNow();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.workspace.toLowerCase().includes(q) ||
        (s.agentBranch || "").toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const { groups, childrenByParent } = useMemo(
    () => groupByProject(filtered, busyIds, askPendingIds),
    [filtered, busyIds, askPendingIds],
  );
  const activeSession = sessions.find((s) => s.id === activeId);
  const activeWorkspace =
    activeSession?.projectWorkspace ||
    (activeSession?.parentSessionId
      ? sessions.find((s) => s.id === activeSession.parentSessionId)?.workspace
      : activeSession?.workspace);

  function toggle(key: string) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function startRename(session: SessionItem) {
    if (!onRename) return;
    setRenamingId(session.id);
    setRenameDraft(session.title);
  }

  function commitRename() {
    if (!renamingId || !onRename) {
      setRenamingId(null);
      return;
    }
    const next = renameDraft.trim();
    const current = sessions.find((s) => s.id === renamingId);
    setRenamingId(null);
    if (!next || !current || next === current.title) return;
    onRename(renamingId, next);
  }

  function renderSessionRow(session: SessionItem, opts?: { nested?: boolean }) {
    const isBusy = Boolean(session.busy) || Boolean(busyIds?.has(session.id));
    const hasAsk = Boolean(askPendingIds?.has(session.id));
    const active = activeId === session.id;
    const activity = formatRelativeShort(session.updatedAt, now);
    const editing = renamingId === session.id;
    const kids = childrenByParent.get(session.id) ?? [];

    return (
      <li key={session.id}>
        <div
          className={`group flex items-center gap-0.5 rounded-lg px-1.5 py-1 transition-colors duration-150 ${
            opts?.nested ? "ml-2" : ""
          } ${
            active
              ? "bg-elevated/80 text-ink"
              : "text-muted hover:bg-white/[0.03] hover:text-ink"
          }`}
        >
          {editing ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                }
                if (e.key === "Escape") setRenamingId(null);
              }}
              className="min-w-0 flex-1 rounded bg-surface px-1.5 py-0.5 text-[13px] text-ink outline-none ring-1 ring-accent/40"
            />
          ) : (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]"
              onClick={() => onSelect(session.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                startRename(session);
              }}
              title={
                session.agentBranch
                  ? `${session.agentBranch} · double-click to rename`
                  : "Double-click to rename"
              }
            >
              {opts?.nested ? (
                <span className="shrink-0 text-[10px] text-muted/70">↳</span>
              ) : null}
              {hasAsk ? <AskBadge /> : isBusy ? <BusyDot /> : null}
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              <ChildStatusBadge status={session.childStatus} />
              {activity ? (
                <span
                  className="shrink-0 text-[10px] tabular-nums text-muted/75"
                  title={new Date(session.updatedAt).toLocaleString()}
                >
                  {activity}
                </span>
              ) : null}
            </button>
          )}
          <button
            type="button"
            aria-label="Delete session"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-70 transition-opacity duration-150 hover:text-ink md:opacity-0 md:group-hover:opacity-100"
            onClick={() => onDelete(session.id)}
          >
            <Trash2 size={13} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        {kids.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5 border-l border-line/40 ml-4 pl-1">
            {kids.map((child) => renderSessionRow(child, { nested: true }))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-line/60 bg-panel">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-2.5">
        <p className="px-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
          Projects
        </p>
        <button
          type="button"
          onClick={() => onNew()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-[var(--color-accent-ink)] transition-transform duration-150 hover:opacity-90 active:scale-95"
          title="New chat"
          aria-label="New chat"
        >
          <Plus {...iconProps} />
        </button>
      </div>

      <div className="px-2.5 pb-2">
        <label className="relative block">
          <Search
            size={14}
            strokeWidth={1.75}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full rounded-lg border border-line/60 bg-surface/60 py-1.5 pl-8 pr-2.5 text-[13px] text-ink outline-none placeholder:text-muted/70 focus:border-accent/40"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 pt-0.5">
        {groups.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted">
            {query.trim() ? "No matching chats" : "No projects yet"}
          </p>
        ) : null}

        {groups.map((group) => {
          const isCollapsed = collapsed[group.key] === true;
          const isActiveProject =
            activeWorkspace && normalizeWorkspace(activeWorkspace) === group.key;

          return (
            <section
              key={group.key}
              className="mb-1 animate-[fadeSlideIn_220ms_ease-out]"
            >
              <div
                className={`flex items-center gap-0.5 rounded-xl px-0.5 py-0.5 transition-colors duration-150 ${
                  isActiveProject ? "bg-white/[0.03]" : ""
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white/[0.03] active:bg-white/[0.05]"
                  onClick={() => toggle(group.key)}
                  title={group.workspace}
                >
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[13px] font-medium text-ink">{group.name}</p>
                    {group.anyAsk ? <AskBadge /> : null}
                    {group.anyBusy ? (
                      <BusyDot title="A chat in this project is working" />
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted/80">
                    {group.workspace}
                  </p>
                </button>
                <button
                  type="button"
                  title="New chat in this project"
                  aria-label="New chat in this project"
                  className="mr-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-all duration-150 hover:bg-white/[0.04] hover:text-ink active:scale-95"
                  onClick={() => onNew(group.workspace)}
                >
                  <MessageSquarePlus size={15} strokeWidth={1.75} aria-hidden />
                </button>
              </div>

              <div
                className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                }`}
              >
                <ul className="mt-0.5 min-h-0 space-y-0.5 overflow-hidden border-l border-line/50 ml-3 pl-2">
                  {group.sessions.map((session) => renderSessionRow(session))}
                </ul>
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
