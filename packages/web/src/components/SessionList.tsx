import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, Plus, Search, Trash2 } from "lucide-react";
import type { ChildAgentStatus, ProjectListItem, SessionSummary } from "../lib/api";
import { formatRelativeShort } from "../lib/time";
import { iconProps } from "./icons";

type Props = {
  projects: ProjectListItem[];
  hasMoreProjects: boolean;
  loadingMoreProjects?: boolean;
  onLoadMoreProjects: () => void;
  onLoadMoreSessions: (workspace: string, key: string) => void;
  loadingSessionsKey?: string | null;
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
  projects,
  hasMoreProjects,
  loadingMoreProjects,
  onLoadMoreProjects,
  onLoadMoreSessions,
  loadingSessionsKey,
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
  const listRef = useRef<HTMLDivElement>(null);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects
      .map((project) => {
        const sessions = project.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.workspace.toLowerCase().includes(q) ||
            (s.agentBranch || "").toLowerCase().includes(q) ||
            project.name.toLowerCase().includes(q) ||
            project.workspace.toLowerCase().includes(q),
        );
        if (
          sessions.length === 0 &&
          !project.name.toLowerCase().includes(q) &&
          !project.workspace.toLowerCase().includes(q)
        ) {
          return null;
        }
        return { ...project, sessions: sessions.length ? sessions : project.sessions };
      })
      .filter(Boolean) as ProjectListItem[];
  }, [projects, query]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const project of filteredProjects) {
      for (const child of project.children) {
        if (!child.parentSessionId) continue;
        const list = map.get(child.parentSessionId) ?? [];
        list.push(child);
        map.set(child.parentSessionId, list);
      }
    }
    for (const [, list] of map) {
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [filteredProjects]);

  const allSessions = useMemo(() => {
    const out: SessionSummary[] = [];
    for (const project of projects) {
      out.push(...project.sessions, ...project.children);
    }
    return out;
  }, [projects]);

  const activeSession = allSessions.find((s) => s.id === activeId);
  const activeWorkspace =
    activeSession?.projectWorkspace ||
    (activeSession?.parentSessionId
      ? allSessions.find((s) => s.id === activeSession.parentSessionId)?.workspace
      : activeSession?.workspace);

  useEffect(() => {
    const el = listRef.current;
    if (!el || query.trim()) return;
    function onScroll() {
      if (!el || !hasMoreProjects || loadingMoreProjects) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance < 120) onLoadMoreProjects();
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMoreProjects, loadingMoreProjects, onLoadMoreProjects, query]);

  function toggle(key: string) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function startRename(session: SessionSummary) {
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
    const current = allSessions.find((s) => s.id === renamingId);
    setRenamingId(null);
    if (!next || !current || next === current.title) return;
    onRename(renamingId, next);
  }

  function renderSessionRow(session: SessionSummary, opts?: { nested?: boolean }) {
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

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 pt-0.5"
      >
        {filteredProjects.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted">
            {query.trim() ? "No matching chats" : "No projects yet"}
          </p>
        ) : null}

        {filteredProjects.map((group) => {
          const isCollapsed = collapsed[group.key] === true;
          const isActiveProject =
            activeWorkspace && normalizeWorkspace(activeWorkspace) === group.key;
          const anyBusy =
            group.sessions.some((s) => s.busy || busyIds?.has(s.id)) ||
            group.children.some((c) => c.busy || busyIds?.has(c.id));
          const anyAsk =
            group.sessions.some((s) => askPendingIds?.has(s.id)) ||
            group.children.some((c) => askPendingIds?.has(c.id));

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
                    {anyAsk ? <AskBadge /> : null}
                    {anyBusy ? (
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
                  {!query.trim() && group.hasMoreSessions ? (
                    <li className="pt-0.5">
                      <button
                        type="button"
                        disabled={loadingSessionsKey === group.key}
                        onClick={() => onLoadMoreSessions(group.workspace, group.key)}
                        className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted transition-colors hover:bg-white/[0.03] hover:text-ink disabled:opacity-50"
                      >
                        {loadingSessionsKey === group.key
                          ? "Loading…"
                          : `Show more chats (${group.totalSessions - group.sessions.length})`}
                      </button>
                    </li>
                  ) : null}
                </ul>
              </div>
            </section>
          );
        })}

        {!query.trim() && hasMoreProjects ? (
          <p className="px-2 py-2 text-center text-[11px] text-muted">
            {loadingMoreProjects ? "Loading projects…" : "Scroll for more projects"}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
