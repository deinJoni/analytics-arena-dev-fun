"use client";

import { useRouter } from "next/navigation";
import type { MatchupCell } from "@/lib/types";

// Diverging fill around 0 bb/100: red = A loses, blue = A wins, gray = even.
const NEUTRAL: [number, number, number] = [0x38, 0x38, 0x35];
const POS: [number, number, number] = [0x39, 0x87, 0xe5];
const NEG: [number, number, number] = [0xe6, 0x67, 0x67];
const CAP = 150; // |bb/100| that saturates the ramp

function cellColor(v: number): string {
  const t = Math.min(1, Math.abs(v) / CAP);
  const pole = v >= 0 ? POS : NEG;
  const c = NEUTRAL.map((n, i) => Math.round(n + (pole[i] - n) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface MatrixAgent {
  agentId: string;
  name: string;
  rank: number | null;
}

export function MatchupMatrix({
  agents,
  cells,
  focusId,
}: {
  agents: MatrixAgent[]; // row/col order, already capped by the caller
  cells: MatchupCell[];
  focusId?: string | null;
}) {
  const router = useRouter();
  const byPair = new Map(cells.map((c) => [`${c.agentAId}|${c.agentBId}`, c]));

  return (
    <div className="overflow-x-auto p-4">
      <table className="border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-surface pr-2 text-right align-bottom">
              <span className="eyebrow">A ↓ vs B →</span>
            </th>
            {agents.map((b) => (
              <th key={b.agentId} className="h-24 min-w-7 align-bottom">
                <span
                  className="inline-block origin-bottom-left -rotate-45 whitespace-nowrap font-mono text-[10px] font-normal text-ink3"
                  title={b.name}
                >
                  {b.name.length > 14 ? `${b.name.slice(0, 13)}…` : b.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agentId} className={focusId === a.agentId ? "outline outline-1 outline-accent/50" : ""}>
              <th className="sticky left-0 z-10 bg-surface pr-2 text-right">
                <span className="whitespace-nowrap font-mono text-[10px] font-normal text-ink2">
                  <span className="mr-1 text-ink3">{a.rank ?? "·"}</span>
                  {a.name.length > 18 ? `${a.name.slice(0, 17)}…` : a.name}
                </span>
              </th>
              {agents.map((b) => {
                if (a.agentId === b.agentId) {
                  return <td key={b.agentId} className="h-7 w-7 rounded-sm bg-bg" />;
                }
                const cell = byPair.get(`${a.agentId}|${b.agentId}`);
                const v = cell?.aDupAdjBbPer100 ?? null;
                if (!cell || v === null) {
                  return (
                    <td
                      key={b.agentId}
                      className="h-7 w-7 rounded-sm bg-surface2/60"
                      title={`${a.name} vs ${b.name}: not played`}
                    />
                  );
                }
                const thin = (cell.completedPairs ?? 0) < 10;
                return (
                  <td
                    key={b.agentId}
                    onClick={() => router.push(`/matchups/${a.agentId}/${b.agentId}`)}
                    className="h-7 w-7 cursor-pointer rounded-sm transition-transform hover:scale-110 hover:outline hover:outline-1 hover:outline-cardface"
                    style={{ background: cellColor(v), opacity: thin ? 0.45 : 1 }}
                    title={`${a.name} vs ${b.name}: ${v > 0 ? "+" : ""}${v.toFixed(1)} bb/100 dup-adj · ${cell.completedPairs ?? 0} pairs${thin ? " (thin)" : ""}`}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-2 text-[10px] text-ink3">
        <span>A loses</span>
        <span className="h-2.5 w-24 rounded-sm" style={{ background: `linear-gradient(to right, rgb(230,103,103), rgb(56,56,53), rgb(57,135,229))` }} />
        <span>A wins (dup-adj bb/100, saturates at ±{CAP})</span>
        <span className="ml-3 inline-block h-2.5 w-2.5 rounded-sm bg-surface2/60" /> not played
        <span className="ml-3 opacity-45">faded = fewer than 10 completed pairs</span>
      </div>
    </div>
  );
}
