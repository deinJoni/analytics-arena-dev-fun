"use client";

import type { SizingSplit } from "@/lib/types";

const BUCKETS = ["0-33", "33-66", "66-100", "100+"] as const;
// ordinal blue ramp (light -> dark = small -> huge), validated dark-mode steps
const BUCKET_COLOR: Record<string, string> = {
  "0-33": "#86b6ef",
  "33-66": "#3987e5",
  "66-100": "#256abf",
  "100+": "#184f95",
};

const STREETS = ["Preflop", "Flop", "Turn", "River"];

// Bet-size mix as one 100%-stacked bar per (street, position) — same visual
// language as the range tiles: segment width = share of that spot's bets.
export function SizingBreakdown({ splits }: { splits: SizingSplit[] }) {
  const byKey = new Map(splits.map((s) => [`${s.street}|${s.position}`, s]));
  const streets = STREETS.filter(
    (st) => byKey.has(`${st}|IP`) || byKey.has(`${st}|OOP`),
  );

  if (streets.length === 0) {
    return <p className="py-4 text-xs text-ink3">no sized bets yet</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink3">
        {BUCKETS.map((b) => (
          <span key={b} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: BUCKET_COLOR[b] }}
            />
            {b}% of pot
          </span>
        ))}
        <span className="ml-auto">preflop raises are usually &gt;100% pot by definition</span>
      </div>

      {streets.map((street) => (
        <div key={street}>
          <p className="eyebrow mb-1.5">{street}</p>
          <div className="space-y-1">
            {(["IP", "OOP"] as const).map((pos) => {
              const s = byKey.get(`${street}|${pos}`);
              return (
                <div key={pos} className="flex items-center gap-2.5">
                  <span className="w-8 shrink-0 font-mono text-[10px] text-ink3">{pos}</span>
                  {!s || s.total === 0 ? (
                    <span className="flex-1 text-[10px] text-ink3/70">no sized bets</span>
                  ) : (
                    <>
                      <span className="flex h-4 flex-1 overflow-hidden rounded-[3px]">
                        {BUCKETS.map((b) => {
                          const n = s.buckets[b] ?? 0;
                          if (n === 0) return null;
                          const pct = (n / s.total) * 100;
                          return (
                            <span
                              key={b}
                              className="flex items-center justify-center font-mono text-[9px] text-ink"
                              style={{
                                width: `${pct}%`,
                                background: BUCKET_COLOR[b],
                                textShadow: "0 0 3px rgba(0,0,0,0.9)",
                              }}
                              title={`${street} · ${pos} · ${b}% of pot: ${n} bet${n === 1 ? "" : "s"} (${Math.round(pct)}%)`}
                            >
                              {pct >= 12 ? n : ""}
                            </span>
                          );
                        })}
                      </span>
                      <span className="num w-24 shrink-0 text-right text-[10px] text-ink3">
                        {s.total}× · avg{" "}
                        {s.avgPotFraction === null
                          ? "—"
                          : `${Math.round(s.avgPotFraction * 100)}%`}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
