import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { AuthMode, ConfigDocDetail, ConfigDocSource, ConfigDocSummary } from "../lib/api";
import {
  getConfigDoc,
  getConversation,
  getMcp,
  listAgents,
  listConfigRules,
  listConfigSkills,
  resumeSession,
  saveMcp,
} from "../lib/api";
import { iconProps } from "./icons";

type Props = {
  auth: AuthMode;
  sessionId: string | null;
  workspace: string;
  open: boolean;
  onClose: () => void;
  onImported: (sessionId: string) => void;
  onError: (message: string) => void;
};

type Tab = "mcp" | "rules" | "skills" | "agents" | "conversation";

const TAB_LABEL: Record<Tab, string> = {
  mcp: "MCP",
  rules: "Rules",
  skills: "Skills",
  agents: "Agents",
  conversation: "Conversation",
};

const SOURCE_LABEL: Record<ConfigDocSource, string> = {
  builtin: "Built-in",
  user: "User",
  project: "Project",
};

const SOURCE_ORDER: ConfigDocSource[] = ["builtin", "user", "project"];

function groupBySource(items: ConfigDocSummary[]): Record<ConfigDocSource, ConfigDocSummary[]> {
  const groups: Record<ConfigDocSource, ConfigDocSummary[]> = {
    builtin: [],
    user: [],
    project: [],
  };
  for (const item of items) {
    groups[item.source].push(item);
  }
  return groups;
}

export function SettingsPanel({
  auth,
  sessionId,
  workspace,
  open,
  onClose,
  onImported,
  onError,
}: Props) {
  const [tab, setTab] = useState<Tab>("mcp");
  const [agents, setAgents] = useState<
    { agentId: string; name: string; summary: string; lastModified: number }[]
  >([]);
  const [mcpText, setMcpText] = useState("{}");
  const [mcpSaved, setMcpSaved] = useState(false);
  const [conversation, setConversation] = useState("");
  const [rules, setRules] = useState<ConfigDocSummary[]>([]);
  const [skills, setSkills] = useState<ConfigDocSummary[]>([]);
  const [doc, setDoc] = useState<ConfigDocDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMcpSaved(false);
    setDoc(null);
    void refreshTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, sessionId, workspace]);

  async function refreshTab(next: Tab) {
    setBusy(true);
    try {
      if (next === "agents") {
        const res = await listAgents(auth, workspace || undefined);
        setAgents(res.items);
      } else if (next === "mcp") {
        const res = await getMcp(auth);
        setMcpText(JSON.stringify(res.servers, null, 2));
      } else if (next === "conversation" && sessionId) {
        const res = await getConversation(auth, sessionId);
        setConversation(JSON.stringify(res.conversation, null, 2));
      } else if (next === "rules") {
        const res = await listConfigRules(auth, workspace || undefined);
        setRules(res.items);
      } else if (next === "skills") {
        const res = await listConfigSkills(auth, workspace || undefined);
        setSkills(res.items);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openDoc(item: ConfigDocSummary) {
    setBusy(true);
    try {
      const detail = await getConfigDoc(auth, item.path, workspace || undefined);
      setDoc(detail);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const ruleGroups = useMemo(() => groupBySource(rules), [rules]);
  const skillGroups = useMemo(() => groupBySource(skills), [skills]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/55 p-3 backdrop-blur-[2px] md:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line/70 bg-panel/95 shadow-2xl backdrop-blur-md"
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-3">
          <p className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            Settings
          </p>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X {...iconProps} />
          </button>
        </div>

        <div className="px-3 pb-2">
          <div
            className="flex gap-0.5 overflow-x-auto rounded-xl bg-white/[0.03] p-0.5"
            role="tablist"
            aria-label="Settings sections"
          >
            {(["mcp", "rules", "skills", "agents", "conversation"] as const).map((id) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setDoc(null);
                    setTab(id);
                  }}
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
                    active
                      ? "bg-elevated text-ink"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {TAB_LABEL[id]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-4 text-sm">
          {busy ? (
            <p className="mb-3 text-[12px] text-muted">Loading…</p>
          ) : null}

          {doc ? (
            <div className="space-y-3">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-[12px] text-muted transition-colors hover:bg-white/[0.03] hover:text-ink"
                onClick={() => setDoc(null)}
              >
                <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />
                Back
              </button>
              <div>
                <p className="text-[15px] font-medium text-ink">{doc.name}</p>
                <p className="mt-1 font-mono text-[11px] text-muted">
                  {SOURCE_LABEL[doc.source]} · {doc.kind}
                </p>
                {doc.description ? (
                  <p className="mt-2 text-[12px] leading-relaxed text-muted">
                    {doc.description}
                  </p>
                ) : null}
              </div>
              <pre className="max-h-[min(50vh,28rem)] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/50 bg-elevated/50 p-3 font-mono text-[11px] leading-relaxed text-muted">
                {doc.content}
              </pre>
            </div>
          ) : null}

          {!doc && tab === "mcp" ? (
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-muted">
                Saved to{" "}
                <code className="rounded bg-elevated/60 px-1 py-0.5 font-mono text-[11px]">
                  ~/.webcli/mcp.json
                </code>{" "}
                and passed into the agent on create / send.
              </p>
              <textarea
                value={mcpText}
                onChange={(e) => {
                  setMcpText(e.target.value);
                  setMcpSaved(false);
                }}
                rows={14}
                spellCheck={false}
                style={{
                  backgroundColor: "var(--color-elevated)",
                  color: "var(--color-ink)",
                  WebkitTextFillColor: "var(--color-ink)",
                  caretColor: "var(--color-ink)",
                }}
                className="w-full resize-y rounded-xl border border-line/50 px-3 py-2.5 font-mono text-xs leading-relaxed outline-none transition-[border-color] [color-scheme:dark] focus:border-line"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent-ink)] transition-opacity hover:opacity-90"
                  onClick={() => {
                    void (async () => {
                      try {
                        const parsed = JSON.parse(mcpText) as Record<string, unknown>;
                        await saveMcp(auth, parsed);
                        setMcpSaved(true);
                      } catch (err) {
                        onError(err instanceof Error ? err.message : String(err));
                      }
                    })();
                  }}
                >
                  Save MCP
                </button>
                {mcpSaved ? (
                  <span className="text-[12px] text-muted">Saved</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {!doc && tab === "rules" ? (
            <ConfigDocList
              groups={ruleGroups}
              empty="No rules found"
              onOpen={(item) => void openDoc(item)}
            />
          ) : null}

          {!doc && tab === "skills" ? (
            <ConfigDocList
              groups={skillGroups}
              empty="No skills found"
              onOpen={(item) => void openDoc(item)}
            />
          ) : null}

          {!doc && tab === "agents" ? (
            <div className="space-y-2">
              <p className="text-[12px] text-muted">Local agents for this workspace.</p>
              {agents.length === 0 ? (
                <p className="py-6 text-center text-muted">No agents found.</p>
              ) : (
                agents.map((agent) => (
                  <div
                    key={agent.agentId}
                    className="flex items-start justify-between gap-3 rounded-xl border border-line/40 bg-elevated/30 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink">
                        {agent.name || agent.agentId}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted">
                        {agent.agentId}
                      </p>
                      {agent.summary ? (
                        <p className="mt-1 line-clamp-2 text-[12px] text-muted">
                          {agent.summary}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-ink)] transition-opacity hover:opacity-90"
                      onClick={() => {
                        void (async () => {
                          try {
                            const session = await resumeSession(auth, {
                              agentId: agent.agentId,
                              workspace,
                            });
                            onImported(session.id);
                            onClose();
                          } catch (err) {
                            onError(err instanceof Error ? err.message : String(err));
                          }
                        })();
                      }}
                    >
                      Open
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {!doc && tab === "conversation" ? (
            sessionId ? (
              <pre className="max-h-[min(60vh,32rem)] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/50 bg-elevated/40 p-3 font-mono text-[11px] leading-relaxed text-muted">
                {conversation || "Empty"}
              </pre>
            ) : (
              <p className="py-6 text-center text-muted">Open a session first</p>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConfigDocList({
  groups,
  empty,
  onOpen,
}: {
  groups: Record<ConfigDocSource, ConfigDocSummary[]>;
  empty: string;
  onOpen: (item: ConfigDocSummary) => void;
}) {
  const total = SOURCE_ORDER.reduce((n, s) => n + groups[s].length, 0);
  if (total === 0) {
    return <p className="py-6 text-center text-muted">{empty}</p>;
  }
  return (
    <div className="space-y-4">
      {SOURCE_ORDER.map((source) => {
        const items = groups[source];
        if (items.length === 0) return null;
        return (
          <section key={source}>
            <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
              {SOURCE_LABEL[source]}
            </p>
            <ul className="space-y-1">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(item)}
                    className="w-full rounded-xl border border-transparent px-3 py-2 text-left transition-colors hover:border-line/50 hover:bg-white/[0.03]"
                  >
                    <p className="truncate text-[13px] text-ink">{item.name}</p>
                    {item.description ? (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">
                        {item.description}
                      </p>
                    ) : (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                        {item.path}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
