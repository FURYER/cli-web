/** Wall-clock time for chat bubbles (e.g. "14:32"). */
export function formatMessageTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const sameDay =
    d.getFullYear() === new Date(now).getFullYear() &&
    d.getMonth() === new Date(now).getMonth() &&
    d.getDate() === new Date(now).getDate();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  return `${date}, ${time}`;
}

/** Compact relative time for sidebar (e.g. "just now", "2h", "3d"). */
export function formatRelativeShort(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week}w`;
  return new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
