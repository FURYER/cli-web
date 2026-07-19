import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import type { AuthMode, Board, BoardCard } from "../lib/api";
import {
  addBoardCard,
  addBoardColumn,
  deleteBoardCard,
  deleteBoardColumn,
  getBoard,
  moveBoardCard,
  patchBoardCard,
  patchBoardColumn,
} from "../lib/api";
import { iconProps } from "./icons";
import { VoiceCaptureButton } from "./VoiceCaptureButton";

type Props = {
  auth: AuthMode;
  workspace: string;
  open: boolean;
  onClose: () => void;
  onInsertToChat?: (text: string) => void;
  onError: (message: string) => void;
  /** Bump when WS board_updated arrives for this workspace. */
  refreshKey?: number;
};

export function BoardPanel({
  auth,
  workspace,
  open,
  onClose,
  onInsertToChat,
  onError,
  refreshKey = 0,
}: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [dragCardId, setDragCardId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace.trim()) return;
    setBusy(true);
    try {
      const next = await getBoard(auth, workspace);
      setBoard(next);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [auth, workspace, onError]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, refreshKey]);

  const columns = useMemo(
    () => (board ? [...board.columns].sort((a, b) => a.order - b.order) : []),
    [board],
  );

  const selected = useMemo(
    () => board?.cards.find((c) => c.id === selectedId) ?? null,
    [board, selectedId],
  );

  function cardsInColumn(columnId: string): BoardCard[] {
    if (!board) return [];
    return board.cards
      .filter((c) => c.columnId === columnId)
      .sort((a, b) => a.order - b.order);
  }

  async function apply(next: Promise<Board>) {
    setBusy(true);
    try {
      setBoard(await next);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCard(columnId: string) {
    const title = newCardTitle.trim();
    if (!title) return;
    setNewCardTitle("");
    setAddingFor(null);
    await apply(addBoardCard(auth, workspace, { title, columnId }));
  }

  async function handleRenameColumn(columnId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    await apply(patchBoardColumn(auth, workspace, columnId, { title: t }));
  }

  async function handleDeleteColumn(columnId: string) {
    if (!board || board.columns.length <= 1) return;
    const col = board.columns.find((c) => c.id === columnId);
    const n = board.cards.filter((c) => c.columnId === columnId).length;
    const ok = window.confirm(
      n > 0
        ? `Delete column “${col?.title ?? columnId}”? ${n} card(s) move to another column.`
        : `Delete column “${col?.title ?? columnId}”?`,
    );
    if (!ok) return;
    if (selectedId && board.cards.some((c) => c.id === selectedId && c.columnId === columnId)) {
      setSelectedId(null);
    }
    await apply(deleteBoardColumn(auth, workspace, columnId));
  }

  async function handleSaveCard(card: BoardCard) {
    const title = draftTitle.trim() || card.title;
    await apply(
      patchBoardCard(auth, workspace, card.id, {
        title,
        body: card.body,
      }),
    );
  }

  async function handleDrop(columnId: string) {
    if (!dragCardId || !board) return;
    const card = board.cards.find((c) => c.id === dragCardId);
    setDragCardId(null);
    if (!card || card.columnId === columnId) return;
    const order =
      (() => {
        const inColumn = board.cards.filter((c) => c.columnId === columnId);
        return inColumn.length
          ? Math.min(...inColumn.map((c) => c.order)) - 1
          : 0;
      })();
    await apply(
      moveBoardCard(auth, workspace, dragCardId, { columnId, order }),
    );
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-30 flex items-stretch justify-center bg-black/50 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Task board"
      onClick={onClose}
    >
      <div
        className="relative flex h-full max-h-full w-full max-w-6xl flex-col overflow-hidden border-line bg-panel shadow-xl sm:max-h-full sm:rounded-xl sm:border sm:bg-panel/95 sm:backdrop-blur-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink">Board</h2>
            <p className="truncate text-[11px] text-muted">{workspace}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void apply(addBoardColumn(auth, workspace, "Column"))
              }
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-ink disabled:opacity-50"
            >
              <Plus size={14} strokeWidth={1.75} />
              Column
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-ink"
              aria-label="Close board"
            >
              <X {...iconProps} />
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-3">
            {columns.map((col) => (
              <div
                key={col.id}
                className="flex w-[min(16rem,calc(100vw-2.5rem))] shrink-0 flex-col rounded-lg bg-elevated/50 sm:w-64"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDrop(col.id);
                }}
              >
                <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-1">
                  <input
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none"
                    defaultValue={col.title}
                    key={`${col.id}:${col.title}`}
                    onBlur={(e) => {
                      if (e.target.value.trim() !== col.title) {
                        void handleRenameColumn(col.id, e.target.value);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy || columns.length <= 1}
                    onClick={() => void handleDeleteColumn(col.id)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-ink disabled:opacity-30"
                    title={
                      columns.length <= 1
                        ? "Keep at least one column"
                        : "Delete column"
                    }
                    aria-label="Delete column"
                  >
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                  {cardsInColumn(col.id).map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        setDragCardId(card.id);
                        e.dataTransfer.setData("text/plain", card.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => setDragCardId(null)}
                      onClick={() => {
                        setSelectedId(card.id);
                        setDraftTitle(card.title);
                      }}
                      className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                        selectedId === card.id
                          ? "border-accent/40 bg-surface"
                          : "border-line/60 bg-surface/80 hover:border-line"
                      } ${dragCardId === card.id ? "opacity-50" : ""}`}
                    >
                      <div className="text-[10px] font-mono text-muted">{card.id}</div>
                      <div className="break-words text-[13px] leading-snug text-ink">
                        {card.title}
                      </div>
                    </button>
                  ))}
                  {addingFor === col.id ? (
                    <form
                      className="rounded-md border border-line bg-surface p-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleAddCard(col.id);
                      }}
                    >
                      <input
                        autoFocus
                        value={newCardTitle}
                        onChange={(e) => setNewCardTitle(e.target.value)}
                        placeholder="Card title"
                        className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
                      />
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <button
                          type="submit"
                          className="rounded bg-accent/90 px-2 py-0.5 text-[11px] font-medium text-[var(--color-accent-ink)]"
                        >
                          Add
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAddingFor(null);
                            setNewCardTitle("");
                          }}
                          className="rounded px-2 py-0.5 text-[11px] text-muted hover:text-ink"
                        >
                          Cancel
                        </button>
                        <VoiceCaptureButton
                          auth={auth}
                          disabled={busy}
                          className="ml-auto flex items-center"
                          onTranscript={(piece) => {
                            setNewCardTitle((prev) => {
                              const base = prev.trimEnd();
                              return base ? `${base} ${piece}` : piece;
                            });
                          }}
                        />
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setAddingFor(col.id)}
                        className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-[12px] text-muted hover:bg-surface/60 hover:text-ink"
                      >
                        + Add card
                      </button>
                      <VoiceCaptureButton
                        auth={auth}
                        disabled={busy}
                        onTranscript={(piece) => {
                          setAddingFor(col.id);
                          setNewCardTitle(piece);
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
            {columns.length === 0 && busy ? (
              <div className="flex gap-3 p-1" aria-busy="true" aria-label="Loading board">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-elevated/50 p-3"
                  >
                    <div className="h-3.5 w-24 animate-pulse rounded bg-white/[0.06]" />
                    <div className="h-14 animate-pulse rounded-md bg-white/[0.06]" />
                    <div className="h-14 animate-pulse rounded-md bg-white/[0.06]" />
                    <div className="h-8 animate-pulse rounded-md bg-white/[0.04]" />
                  </div>
                ))}
              </div>
            ) : null}
            {columns.length === 0 && !busy ? (
              <p className="p-4 text-sm text-muted">No columns yet.</p>
            ) : null}
          </div>

          {selected ? (
            <aside
              className="absolute inset-0 z-20 flex flex-col bg-panel p-3 sm:static sm:inset-auto sm:z-auto sm:w-80 sm:shrink-0 sm:border-l sm:border-line sm:bg-surface/40"
              aria-label={`Card ${selected.id}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-muted">{selected.id}</span>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-ink"
                  aria-label="Close card"
                >
                  <X {...iconProps} />
                </button>
              </div>
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={() => void handleSaveCard({ ...selected, title: draftTitle })}
                className="mb-2 w-full rounded-md border border-line bg-elevated/50 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/40"
              />
              <textarea
                value={selected.body}
                onChange={(e) => {
                  setBoard((prev) => {
                    if (!prev) return prev;
                    return {
                      ...prev,
                      cards: prev.cards.map((c) =>
                        c.id === selected.id ? { ...c, body: e.target.value } : c,
                      ),
                    };
                  });
                }}
                onBlur={(e) =>
                  void apply(
                    patchBoardCard(auth, workspace, selected.id, {
                      body: e.target.value,
                    }),
                  )
                }
                placeholder="Notes…"
                rows={8}
                className="mb-3 min-h-[8rem] w-full flex-1 resize-none rounded-md border border-line bg-elevated/50 px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent/40"
              />
              <div className="flex flex-wrap gap-2 pb-[env(safe-area-inset-bottom)]">
                {onInsertToChat ? (
                  <button
                    type="button"
                    onClick={() => {
                      onInsertToChat(`#${selected.id}`);
                      onClose();
                    }}
                    className="rounded-md bg-accent/90 px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-accent-ink)]"
                  >
                    To chat
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    const id = selected.id;
                    setSelectedId(null);
                    void apply(deleteBoardCard(auth, workspace, id));
                  }}
                  className="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:bg-elevated hover:text-ink"
                >
                  Delete
                </button>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
