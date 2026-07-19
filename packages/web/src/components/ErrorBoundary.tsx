import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/** Catch render crashes so the phone does not stay on a permanent white screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("UI crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error.message || String(this.state.error);
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-bg px-6 text-center text-ink">
        <div className="max-w-md space-y-2">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted break-words">{message}</p>
        </div>
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
          onClick={() => {
            try {
              const url = new URL(window.location.href);
              url.searchParams.set("_r", String(Date.now()));
              window.location.replace(url.toString());
            } catch {
              window.location.reload();
            }
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
