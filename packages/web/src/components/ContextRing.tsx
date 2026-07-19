import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ContextSnapshot, TokenUsage } from "../lib/api";
import {
  colorForCategory,
  formatTokenCount,
  snapshotFromUsage,
} from "../lib/contextUsage";

type Props = {
  usage?: TokenUsage | null;
  context?: ContextSnapshot | null;
};

function ringStroke(percent: number): string {
  if (percent >= 90) return "#f7768e";
  if (percent >= 70) return "#e0af68";
  return "#3c9eff";
}

export function ContextRing({ usage, context }: Props) {
  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  const snapshot = useMemo(() => {
    if (context) return context;
    if (usage) return snapshotFromUsage(usage, null);
    return {
      usedTokens: 0,
      maxTokens: 256_000,
      percent: 0,
      categories: [],
    };
  }, [usage, context]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const size = 18;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const fill = Math.min(100, Math.max(0, snapshot.percent));
  const dash = (fill / 100) * c;
  const strokeColor = ringStroke(Math.min(100, fill));
  const overWindow = snapshot.usedTokens > snapshot.maxTokens;

  const categories = snapshot.categories.filter((cat) => cat.tokens > 0);
  const categoryTotal = categories.reduce((acc, cat) => acc + cat.tokens, 0) || 1;
  const hasData = snapshot.usedTokens > 0;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-describedby={hover ? tipId : undefined}
        title={hover ? undefined : `${Math.round(snapshot.percent)}%`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-ink"
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={stroke}
          />
          {hasData ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={strokeColor}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${c - dash}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="transition-[stroke-dasharray] duration-300"
            />
          ) : null}
        </svg>
        {hover && !open ? (
          <span
            id={tipId}
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 font-mono text-[11px] text-ink shadow-lg"
          >
            {Math.round(snapshot.percent)}%
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
          <div className="flex items-start gap-3 border-b border-line px-3 py-3">
            <svg width={44} height={44} viewBox="0 0 44 44" aria-hidden className="shrink-0">
              <circle
                cx={22}
                cy={22}
                r={16}
                fill="none"
                stroke="var(--color-line)"
                strokeWidth={5}
              />
              {hasData && categories.length ? (
                (() => {
                  let offset = 0;
                  const circ = 2 * Math.PI * 16;
                  return categories.map((cat, i) => {
                    const portion = cat.tokens / categoryTotal;
                    const len = portion * circ * (fill / 100);
                    const el = (
                      <circle
                        key={cat.id}
                        cx={22}
                        cy={22}
                        r={16}
                        fill="none"
                        stroke={colorForCategory(cat.id, i)}
                        strokeWidth={5}
                        strokeDasharray={`${len} ${circ - len}`}
                        strokeDashoffset={-offset}
                        transform="rotate(-90 22 22)"
                      />
                    );
                    offset += len;
                    return el;
                  });
                })()
              ) : hasData ? (
                <circle
                  cx={22}
                  cy={22}
                  r={16}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={5}
                  strokeDasharray={`${(fill / 100) * 2 * Math.PI * 16} ${2 * Math.PI * 16}`}
                  transform="rotate(-90 22 22)"
                />
              ) : null}
              <circle cx={22} cy={22} r={11} fill="var(--color-panel)" />
              <text
                x={22}
                y={22}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-ink"
                style={{ fontSize: 9, fontFamily: "ui-monospace, monospace" }}
              >
                {Math.round(Math.min(snapshot.percent, 999))}%
              </text>
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Context used</p>
              <p className="mt-0.5 font-mono text-[11px] text-muted">
                {formatTokenCount(snapshot.usedTokens)} /{" "}
                {formatTokenCount(snapshot.maxTokens)}
                {snapshot.estimated ? (
                  <span className="ml-1 text-muted/80">est.</span>
                ) : null}
                {overWindow ? (
                  <span className="ml-1 text-amber-300">over 256k</span>
                ) : null}
              </p>
            </div>
          </div>

          {hasData && categories.length ? (
            <ul className="max-h-64 space-y-1 overflow-auto px-3 py-2">
              {categories.map((cat, i) => {
                const pctOfUsed = Math.round((cat.tokens / categoryTotal) * 1000) / 10;
                return (
                  <li
                    key={cat.id}
                    className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-elevated/60"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: colorForCategory(cat.id, i) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-ink">{cat.label}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted">
                      {formatTokenCount(cat.tokens)}
                      <span className="ml-1 text-muted/70">{pctOfUsed}%</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-muted">
              Send a message to see context breakdown.
            </p>
          )}

          {usage && hasData ? (
            <div className="border-t border-line px-3 py-2 font-mono text-[10px] text-muted">
              {snapshot.estimated
                ? "Ring uses local estimate — SDK totals sum every model call in the turn."
                : null}
              {snapshot.estimated ? <br /> : null}
              Billing · in {formatTokenCount(usage.inputTokens)} · out{" "}
              {formatTokenCount(usage.outputTokens)}
              {usage.cacheReadTokens
                ? ` · cache ${formatTokenCount(usage.cacheReadTokens)}`
                : ""}
              {usage.reasoningTokens
                ? ` · reason ${formatTokenCount(usage.reasoningTokens)}`
                : ""}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
