import { Kanban, MessageSquarePlus, PanelLeft, Settings } from "lucide-react";
import { iconProps } from "./icons";

type Props = {
  visible: boolean;
  title?: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat?: () => void;
  onOpenBoard?: () => void;
  onOpenSettings: () => void;
  onRenameTitle?: () => void;
};

export function AppHeader({
  visible,
  title,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  onOpenBoard,
  onOpenSettings,
  onRenameTitle,
}: Props) {
  const label = title?.trim() || "";

  return (
    <header
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 transition-[transform,opacity] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
        visible
          ? "translate-y-0 opacity-100"
          : "-translate-y-[110%] opacity-0"
      }`}
    >
      <div
        className={`pointer-events-auto flex h-11 items-center justify-between gap-2 bg-gradient-to-b from-surface via-surface/95 to-surface/0 px-2 md:px-3 ${
          visible ? "" : "pointer-events-none"
        }`}
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleSidebar}
            tabIndex={visible ? 0 : -1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-ink"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={sidebarOpen}
            aria-hidden={!visible}
          >
            <PanelLeft {...iconProps} />
          </button>
          {onNewChat ? (
            <button
              type="button"
              onClick={onNewChat}
              tabIndex={visible ? 0 : -1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-ink"
              title="New chat"
              aria-label="New chat"
              aria-hidden={!visible}
            >
              <MessageSquarePlus {...iconProps} />
            </button>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 px-1 text-center">
          {label ? (
            onRenameTitle ? (
              <button
                type="button"
                onClick={onRenameTitle}
                tabIndex={visible ? 0 : -1}
                className="mx-auto block max-w-full truncate rounded-md px-2 py-1 text-[13px] font-medium text-ink hover:bg-elevated/60"
                title="Rename chat"
                aria-hidden={!visible}
              >
                {label}
              </button>
            ) : (
              <p
                className="truncate text-[13px] font-medium text-ink"
                title={label}
                aria-hidden={!visible}
              >
                {label}
              </p>
            )
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {onOpenBoard ? (
            <button
              type="button"
              onClick={onOpenBoard}
              tabIndex={visible ? 0 : -1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-ink"
              title="Board"
              aria-label="Board"
              aria-hidden={!visible}
            >
              <Kanban {...iconProps} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onOpenSettings}
            tabIndex={visible ? 0 : -1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-ink"
            title="Settings"
            aria-label="Settings"
            aria-hidden={!visible}
          >
            <Settings {...iconProps} />
          </button>
        </div>
      </div>
    </header>
  );
}
