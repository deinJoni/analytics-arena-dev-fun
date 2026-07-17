"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import type { MatchupCell } from "@/lib/types";
import { fmtBb, fmtNum, signClass } from "@/lib/format";

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

interface HoverState {
  a: MatrixAgent;
  b: MatrixAgent;
  cell: MatchupCell | undefined;
}

function MatrixPanel({ hover }: { hover: HoverState | null }) {
  if (!hover) {
    return (
      <div className="rounded border border-line bg-surface2/50 p-3 text-[11px] leading-relaxed text-ink3 lg:w-60 lg:shrink-0">
        <p className="eyebrow mb-2">how to read this</p>
        <p>
          Rows are agent <span className="text-ink2">A</span>, columns the opponent{" "}
          <span className="text-ink2">B</span> (numbers = ladder rank), each cell A&apos;s
          dup-adj bb/100 against that rival.
        </p>
        <p className="mt-2">
          <span className="text-pos">blue</span> = A wins the pairing,{" "}
          <span className="text-neg">red</span> = A loses it — mirrored across the diagonal
          because duplicate pairs are zero-sum.
        </p>
        <p className="mt-2">
          Faded cells have fewer than 10 completed pairs; dim empty cells were never played.
        </p>
        <p className="mt-2 text-ink2">Hover a cell for the numbers; click to open the matchup.</p>
      </div>
    );
  }

  const { a, b, cell } = hover;
  const v = cell?.aDupAdjBbPer100 ?? null;
  const thin = (cell?.completedPairs ?? 0) < 10;
  return (
    <div className="rounded border border-line bg-surface2/50 p-3 text-[11px] leading-relaxed lg:w-60 lg:shrink-0">
      <p className="font-mono text-sm font-semibold text-ink">
        {a.name} <span className="text-ink3">#{a.rank ?? "·"}</span>
      </p>
      <p className="text-ink3">
        vs {b.name} <span>#{b.rank ?? "·"}</span>
      </p>
      {!cell ? (
        <p className="mt-2 text-ink3">these two haven&apos;t played yet</p>
      ) : (
        <div className="mt-2 space-y-1">
          <p className={`num text-lg ${signClass(v)}`}>
            {fmtBb(v)} <span className="text-[10px] text-ink3">dup-adj bb/100</span>
          </p>
          <p className="text-ink2">
            raw <span className={`num ${signClass(cell.aRawBbPer100)}`}>{fmtBb(cell.aRawBbPer100)}</span>
            {" · "}wins{" "}
            <span className="num">
              {cell.aWinRate === null ? "—" : `${Math.round(cell.aWinRate * 100)}%`}
            </span>{" "}
            of hands
          </p>
          <p className="text-ink3">
            {fmtNum(cell.completedPairs)} completed pairs · {fmtNum(cell.hands)} hands
            {thin && <span className="text-neg/80"> · thin sample</span>}
          </p>
          <p className="mt-1 text-ink3">click the cell for the spot breakdown →</p>
        </div>
      )}
    </div>
  );
}

// Fluid heat matrix: tiles stretch to the available width (no horizontal
// scrolling); identity lives in the hover panel rather than long axis labels.
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
  const [hover, setHover] = useState<HoverState | null>(null);
  const byPair = new Map(cells.map((c) => [`${c.agentAId}|${c.agentBId}`, c]));

  return (
    <div className="flex flex-col gap-4 p-4 lg:flex-row" onMouseLeave={() => setHover(null)}>
      <div className="min-w-0 flex-1">
        {/* tiles cap at 26px so the top-20 matrix fits a laptop viewport
            without scrolling; on narrow screens they shrink fluidly */}
        <div
          className="grid gap-px"
          style={{
            gridTemplateColumns: `minmax(72px, 110px) repeat(${agents.length}, minmax(0, 26px))`,
          }}
        >
          <div />
          {agents.map((b) => (
            <div
              key={b.agentId}
              className="overflow-hidden pb-0.5 text-center font-mono text-[8px] leading-tight text-ink3"
              title={b.name}
            >
              {b.rank ?? "·"}
            </div>
          ))}
          {agents.map((a) => (
            <Fragment key={a.agentId}>
              <div
                className={`flex items-center justify-end gap-1 overflow-hidden pr-1.5 font-mono text-[9px] leading-none ${
                  focusId === a.agentId ? "text-accent" : "text-ink2"
                }`}
              >
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 text-ink3">{a.rank ?? "·"}</span>
              </div>
              {agents.map((b) => {
                if (a.agentId === b.agentId) {
                  return <div key={b.agentId} className="aspect-square rounded-[2px] bg-bg" />;
                }
                const cell = byPair.get(`${a.agentId}|${b.agentId}`);
                const v = cell?.aDupAdjBbPer100 ?? null;
                const thin = (cell?.completedPairs ?? 0) < 10;
                const isHover = hover?.a.agentId === a.agentId && hover?.b.agentId === b.agentId;
                return (
                  <button
                    key={b.agentId}
                    onMouseEnter={() => setHover({ a, b, cell })}
                    onFocus={() => setHover({ a, b, cell })}
                    onClick={() =>
                      cell && router.push(`/matchups/${a.agentId}/${b.agentId}`)
                    }
                    aria-label={`${a.name} vs ${b.name}${v === null ? ": not played" : `: ${v.toFixed(1)} dup-adj bb/100`}`}
                    className={`aspect-square rounded-[2px] ${
                      cell ? "cursor-pointer" : "cursor-default"
                    } ${isHover ? "outline outline-1 outline-cardface" : ""}`}
                    style={
                      cell && v !== null
                        ? { background: cellColor(v), opacity: thin ? 0.45 : 1 }
                        : { background: "var(--surface-2)", opacity: 0.6 }
                    }
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-ink3">
          <span>A loses</span>
          <span
            className="h-2.5 w-24 rounded-sm"
            style={{
              background:
                "linear-gradient(to right, rgb(230,103,103), rgb(56,56,53), rgb(57,135,229))",
            }}
          />
          <span>A wins · saturates at ±{CAP} bb/100</span>
        </div>
      </div>
      <MatrixPanel hover={hover} />
    </div>
  );
}
