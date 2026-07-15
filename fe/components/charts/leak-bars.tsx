"use client";

import Link from "next/link";
import type { LeakRow } from "@/lib/types";

const POS = "#3987e5";
const NEG = "#e66767";

export function spotLabel(r: LeakRow): string {
  const tex = r.boardTexture && r.boardTexture !== "na" ? ` · ${r.boardTexture}` : "";
  return `${r.position} · ${r.street}${tex} · ${r.line}`;
}

export function handsHref(agentId: string, r: LeakRow): string {
  const p = new URLSearchParams({ agentId, street: r.street });
  return `/hands?${p.toString()}`;
}

// Ranked diverging bars around a shared zero axis: the money map at a glance.
// Each row deep-links into the hand browser for that spot's street.
export function LeakBars({ rows, agentId }: { rows: LeakRow[]; agentId: string }) {
  const ranked = rows
    .filter((r) => r.mirrorDeltaBb !== null)
    .sort((a, b) => (a.mirrorDeltaBb ?? 0) - (b.mirrorDeltaBb ?? 0))
    .slice(0, 12);

  if (ranked.length === 0) {
    return (
      <p className="px-4 py-8 text-xs text-ink3">
        No spots with mirror data under the current filters.
      </p>
    );
  }

  const maxAbs = Math.max(...ranked.map((r) => Math.abs(r.mirrorDeltaBb ?? 0)), 1);

  return (
    <div className="space-y-1 p-4">
      {ranked.map((r) => {
        const v = r.mirrorDeltaBb ?? 0;
        const w = (Math.abs(v) / maxAbs) * 50; // % of half-width
        return (
          <Link
            key={`${r.position}|${r.street}|${r.boardTexture}|${r.line}`}
            href={handsHref(agentId, r)}
            className="group flex items-center gap-3 rounded px-1 py-0.5 hover:bg-surface2"
            title={`${spotLabel(r)}: ${v > 0 ? "+" : ""}${v.toFixed(1)} bb mirror delta · ${r.mirrorN} deck-sides`}
          >
            <span className="w-56 shrink-0 truncate font-mono text-[11px] text-ink2 group-hover:text-ink">
              {spotLabel(r)}
            </span>
            <span className="relative h-4 flex-1">
              {/* zero axis */}
              <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
              <span
                className="absolute top-0.5 h-3"
                style={{
                  left: v < 0 ? `${50 - w}%` : "50%",
                  width: `${w}%`,
                  background: v < 0 ? NEG : POS,
                  borderRadius: v < 0 ? "4px 0 0 4px" : "0 4px 4px 0",
                }}
              />
            </span>
            <span
              className={`num w-16 shrink-0 text-right text-xs ${v < 0 ? "text-neg" : "text-pos"}`}
            >
              {v > 0 ? "+" : ""}
              {v.toFixed(1)}
            </span>
            <span className="num w-12 shrink-0 text-right text-[10px] text-ink3">
              ×{r.mirrorN}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
