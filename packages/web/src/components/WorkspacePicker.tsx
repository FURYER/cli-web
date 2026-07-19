import { useState } from "react";
import { FolderOpen } from "lucide-react";
import type { AuthMode } from "../lib/api";
import { FolderBrowser } from "./FolderBrowser";
import { iconProps } from "./icons";

type Props = {
  auth: AuthMode;
  workspace: string;
  onWorkspaceChange: (value: string) => void;
  onCreate: () => void;
  busy?: boolean;
};

export function WorkspacePicker({
  auth,
  workspace,
  onWorkspaceChange,
  onCreate,
  busy,
}: Props) {
  const [browserOpen, setBrowserOpen] = useState(false);

  return (
    <div className="space-y-3 rounded-lg bg-panel p-4">
      <div>
        <label className="mb-1 block text-xs uppercase tracking-wide text-muted" htmlFor="workspace">
          Workspace
        </label>
        <div className="flex gap-2">
          <input
            id="workspace"
            value={workspace}
            onChange={(e) => onWorkspaceChange(e.target.value)}
            placeholder="C:\\Users\\...\\project"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md bg-elevated px-3 py-2 font-mono text-sm text-ink outline-none focus:ring-1 focus:ring-accent/40"
          />
          <button
            type="button"
            onClick={() => setBrowserOpen(true)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-elevated text-ink hover:bg-surface"
            title="Browse folders"
            aria-label="Browse folders"
          >
            <FolderOpen {...iconProps} />
          </button>
        </div>
      </div>
      <button
        type="button"
        disabled={busy || !workspace.trim()}
        onClick={onCreate}
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-[var(--color-accent-ink)] disabled:opacity-50"
      >
        {busy ? "Creating…" : "Start session"}
      </button>

      <FolderBrowser
        auth={auth}
        open={browserOpen}
        initialPath={workspace || undefined}
        onClose={() => setBrowserOpen(false)}
        onSelect={onWorkspaceChange}
      />
    </div>
  );
}
