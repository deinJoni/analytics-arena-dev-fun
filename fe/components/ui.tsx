"use client";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  retry,
}: {
  message?: string;
  retry?: () => void;
}) {
  return (
    <div className="card flex flex-col items-start gap-3 p-6">
      <p className="eyebrow text-neg">request failed</p>
      <p className="text-sm text-ink2">
        {message || "The API did not respond. The database may be unreachable."}
      </p>
      {retry && (
        <button
          onClick={retry}
          className="rounded border border-line bg-surface2 px-3 py-1.5 text-sm text-ink hover:border-accent"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card p-6">
      <p className="text-sm text-ink2">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink3">{hint}</p>}
    </div>
  );
}

export function StatChip({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1 text-xl text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink3">{sub}</p>}
    </div>
  );
}

// Sample-size badge: the honesty marker next to every thin stat.
export function SampleBadge({ n, thin = 30 }: { n: number | null; thin?: number }) {
  if (n === null) return null;
  const isThin = n < thin;
  return (
    <span
      className={`num text-[10px] ${isThin ? "text-neg/80" : "text-ink3"}`}
      title={isThin ? `thin sample: n=${n} (< ${thin})` : `n=${n}`}
    >
      n={n}
    </span>
  );
}
