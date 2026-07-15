// Chips are dealt at 5/10 blinds with 1000-chip stacks: bb = chips / 10.
export const chipsToBb = (chips: number) => chips / 10;

export function fmtBb(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(decimals)}%`;
}

export function fmt1(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(1);
}

// text color class for a win/loss number (blue = winning, red = losing)
export function signClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "text-ink3";
  if (n > 0) return "text-pos";
  if (n < 0) return "text-neg";
  return "text-ink2";
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function timeAgo(ts: string | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortId(id: string | null | undefined, n = 6): string {
  if (!id) return "—";
  return `…${id.slice(-n)}`;
}
