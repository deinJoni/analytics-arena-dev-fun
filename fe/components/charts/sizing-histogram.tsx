"use client";

const BUCKETS = ["0-33", "33-66", "66-100", "100+"] as const;
const BLUE = "#3987e5";

// Bet-size distribution as %-of-pot buckets. One series -> one hue; height
// carries magnitude, count labels on top (selective, there are only 4 bars).
export function SizingHistogram({
  data,
  title,
}: {
  data: Record<string, number> | null;
  title: string;
}) {
  const counts = BUCKETS.map((b) => data?.[b] ?? 0);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);

  return (
    <div className="flex-1">
      <p className="eyebrow mb-2">{title}</p>
      {total === 0 ? (
        <p className="py-6 text-xs text-ink3">no sized bets</p>
      ) : (
        <div className="flex h-24 items-end gap-1.5">
          {BUCKETS.map((b, i) => (
            <div key={b} className="group flex flex-1 flex-col items-center gap-1">
              <span className="num text-[10px] text-ink3 group-hover:text-ink">
                {counts[i]}
              </span>
              <div
                className="w-full rounded-t-[4px]"
                style={{
                  height: `${(counts[i] / max) * 64}px`,
                  minHeight: counts[i] > 0 ? 3 : 1,
                  background: counts[i] > 0 ? BLUE : "var(--line)",
                }}
                title={`${b}% of pot: ${counts[i]} bets`}
              />
              <span className="num text-[9px] text-ink3">{b}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
