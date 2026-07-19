type Props = {
  className?: string;
};

/** Soft pulse placeholder block. */
export function Skeleton({ className = "" }: Props) {
  return (
    <div
      className={`animate-pulse rounded-md bg-white/[0.06] ${className}`}
      aria-hidden
    />
  );
}

export function SessionListSkeleton() {
  return (
    <div className="flex h-full w-full flex-col border-r border-line/60 bg-panel px-2.5 pt-3">
      <div className="mb-4 flex items-center justify-between px-1.5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="mb-4 px-1">
          <Skeleton className="mb-1.5 h-3.5 w-28" />
          <Skeleton className="mb-2 h-2.5 w-40" />
          <div className="ml-3 space-y-1.5 border-l border-line/40 pl-2">
            <Skeleton className="h-7 w-full rounded-lg" />
            <Skeleton className="h-7 w-[85%] rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pt-14 pb-4">
      <div className="self-stretch space-y-2">
        <Skeleton className="h-16 w-[85%] rounded-xl" />
        <Skeleton className="ml-1 h-2.5 w-12" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[92%]" />
        <Skeleton className="h-3 w-[70%]" />
      </div>
      <div className="self-stretch space-y-2">
        <Skeleton className="h-12 w-[70%] rounded-xl" />
        <Skeleton className="ml-1 h-2.5 w-12" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-[95%]" />
        <Skeleton className="h-3 w-[80%]" />
        <Skeleton className="h-3 w-[60%]" />
      </div>
    </div>
  );
}

export function BootSplash() {
  return (
    <div
      className="flex h-full min-h-[100dvh] flex-col items-center justify-center gap-5 bg-surface text-ink"
      role="status"
      aria-live="polite"
      aria-label="Loading WebCLI"
    >
      <div className="relative">
        <div className="absolute inset-0 animate-ping rounded-[1.25rem] bg-accent/20" />
        <img
          src="/icon.svg"
          alt=""
          width={72}
          height={72}
          className="relative h-[4.5rem] w-[4.5rem] rounded-[1.25rem] shadow-lg ring-1 ring-line"
        />
      </div>
      <div className="text-center">
        <p className="text-lg font-semibold tracking-tight text-ink">WebCLI</p>
        <p className="mt-1 text-sm text-muted">Starting…</p>
      </div>
      <div className="mt-2 flex w-40 flex-col gap-2">
        <Skeleton className="h-2 w-full" />
        <Skeleton className="mx-auto h-2 w-3/4" />
      </div>
    </div>
  );
}
