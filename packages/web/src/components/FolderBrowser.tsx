import { useEffect, useState } from "react";
import { ArrowUp, File, Folder, X } from "lucide-react";
import { listFs, type AuthMode, type FsListing } from "../lib/api";
import { iconProps } from "./icons";

type Props = {
  auth: AuthMode;
  initialPath?: string;
  open: boolean;
  /** folder = dirs only; file = pick a file; path = file or current folder */
  mode?: "folder" | "file" | "path";
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function FolderBrowser({
  auth,
  initialPath,
  open,
  mode = "folder",
  onClose,
  onSelect,
}: Props) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [current, setCurrent] = useState(initialPath ?? "");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pickFiles = mode === "file" || mode === "path";
  const allowFolder = mode === "folder" || mode === "path";

  useEffect(() => {
    if (!open) return;
    setSelectedFile(null);
    void load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath, mode]);

  async function load(path?: string) {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    try {
      const data = await listFs(auth, path || undefined, { includeFiles: pickFiles });
      setListing(data);
      setCurrent(data.path);
      if (data.warning) setError(data.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const canConfirm =
    mode === "path"
      ? Boolean(selectedFile || current.trim())
      : mode === "file"
        ? Boolean(selectedFile)
        : Boolean(current.trim());

  const title =
    mode === "path"
      ? "Choose file or folder"
      : mode === "file"
        ? "Choose file"
        : "Choose folder";
  const subtitle =
    mode === "path"
      ? "Pick a file, or use the current folder"
      : mode === "file"
        ? "Browse workspace files"
        : "Browse local disks";

  function confirm() {
    if (mode === "file") {
      if (!selectedFile) return;
      onSelect(selectedFile);
    } else if (mode === "path") {
      onSelect((selectedFile || current).trim());
    } else {
      onSelect(current.trim());
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <p className="text-sm font-medium text-ink">{title}</p>
            <p className="font-mono text-[11px] text-muted">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:bg-elevated hover:text-ink"
            aria-label="Close"
          >
            <X {...iconProps} />
          </button>
        </div>

        {listing?.shortcuts?.length ? (
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
            {listing.shortcuts.map((item) => (
              <button
                key={`s-${item.path}`}
                type="button"
                onClick={() => void load(item.path)}
                className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-ink"
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {listing?.roots?.length ? (
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
            {listing.roots.map((root) => (
              <button
                key={root}
                type="button"
                onClick={() => void load(root)}
                className={`rounded border px-2 py-1 font-mono text-xs ${
                  current.toLowerCase().startsWith(root.toLowerCase())
                    ? "border-accent bg-surface text-ink"
                    : "border-line text-muted hover:text-ink"
                }`}
              >
                {root}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <button
            type="button"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void load(listing.parent)}
            className="rounded border border-line px-2 py-1 text-sm disabled:opacity-40"
            title="Up"
            aria-label="Up"
          >
            <ArrowUp {...iconProps} />
          </button>
          <input
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(current);
            }}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(current)}
            className="rounded border border-line px-2 py-1 text-xs"
          >
            Go
          </button>
        </div>

        {error ? (
          <div className="border-b border-line bg-amber-950/40 px-4 py-2 text-sm text-amber-100">
            {error}
          </div>
        ) : null}

        <ul className="min-h-[12rem] flex-1 overflow-y-auto px-1 py-1">
          {loading && !listing ? (
            <li className="px-3 py-8 text-center text-sm text-muted">Loading…</li>
          ) : null}
          {listing?.entries.length === 0 && !loading ? (
            <li className="px-3 py-8 text-center text-sm text-muted">
              {pickFiles ? "Empty folder" : "No subfolders"}
            </li>
          ) : null}
          {listing?.entries.map((entry) => {
            const isDir = entry.type === "dir";
            const selected =
              pickFiles && !isDir
                ? selectedFile === entry.path
                : allowFolder && current === entry.path && !selectedFile;
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  onDoubleClick={() => {
                    if (isDir) {
                      void load(entry.path);
                      return;
                    }
                    if (pickFiles) {
                      onSelect(entry.path);
                      onClose();
                    }
                  }}
                  onClick={() => {
                    if (isDir) {
                      setSelectedFile(null);
                      if (mode === "path" || mode === "folder") {
                        setCurrent(entry.path);
                      } else {
                        void load(entry.path);
                      }
                      return;
                    }
                    if (pickFiles) {
                      setSelectedFile(entry.path);
                      setCurrent(listing?.path ?? current);
                    }
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface ${
                    selected ? "bg-surface" : ""
                  }`}
                >
                  {isDir ? (
                    <Folder {...iconProps} className="shrink-0 text-muted" />
                  ) : (
                    <File {...iconProps} className="shrink-0 text-accent" />
                  )}
                  <span className="truncate font-mono text-ink">{entry.name}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
            {selectedFile || current}
            {mode === "path" && !selectedFile ? (
              <span className="ml-1 text-muted/70">(folder)</span>
            ) : null}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {mode === "path" && selectedFile ? (
              <button
                type="button"
                onClick={() => {
                  onSelect(current.trim());
                  onClose();
                }}
                className="rounded-md px-2.5 py-2 text-sm text-muted hover:bg-elevated hover:text-ink"
              >
                Use folder
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canConfirm}
              onClick={confirm}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-[var(--color-accent-ink)] disabled:opacity-50"
            >
              {mode === "path" && selectedFile
                ? "Select file"
                : mode === "path"
                  ? "Use folder"
                  : "Select"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
