"use client";

import Link from "next/link";
import { use } from "react";
import { useApi } from "@/lib/api";
import type { MatchupDetail } from "@/lib/types";
import { fmtBb, fmtNum, fmtPct, signClass, timeAgo } from "@/lib/format";
import { AgentLink } from "@/components/agent-link";
import { Empty, ErrorState, StatChip, TableSkeleton } from "@/components/ui";

export default function MatchupDetailPage({
  params,
}: {
  params: Promise<{ a: string; b: string }>;
}) {
  const { a, b } = use(params);
  const detail = useApi<MatchupDetail>(`/api/matchups/${a}/${b}`);

  if (detail.isPending) {
    return <div className="card"><TableSkeleton rows={8} /></div>;
  }
  if (detail.isError) {
    return (
      <ErrorState message={(detail.error as Error)?.message} retry={() => detail.refetch()} />
    );
  }

  const m = detail.data;
  const deltas = (m.spotDeltas ?? [])
    .slice()
    .sort((x, y) => x.mirror_delta_bb - y.mirror_delta_bb);

  return (
    <div className="space-y-6">
      <nav className="text-xs text-ink3">
        <Link href="/matchups" className="hover:text-ink2">head-to-head</Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink2">
          {m.agentAName} vs {m.agentBName}
        </span>
      </nav>

      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">matchup — from A&apos;s perspective</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            <AgentLink agentId={m.agentAId} name={m.agentAName} />{" "}
            <span className="text-ink3">vs</span>{" "}
            <AgentLink agentId={m.agentBId} name={m.agentBName} />
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/matchups/${b}/${a}`}
            className="rounded border border-line bg-surface2 px-3 py-1.5 font-mono text-xs text-ink2 hover:border-accent"
          >
            ⇄ flip perspective
          </Link>
          <Link
            href={`/hands?agentId=${a}&opponentId=${b}`}
            className="rounded border border-line bg-surface2 px-3 py-1.5 font-mono text-xs text-ink2 hover:border-accent"
          >
            all hands →
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <StatChip label="blocks" value={fmtNum(m.blocks)} />
        <StatChip
          label="completed pairs"
          value={fmtNum(m.completedPairs)}
          sub={(m.completedPairs ?? 0) < 10 ? "thin sample" : undefined}
        />
        <StatChip label="hands" value={fmtNum(m.hands)} />
        <StatChip
          label="A win rate"
          value={m.aWinRate === null ? "—" : fmtPct(m.aWinRate * 100, 0)}
          sub="share of hands won"
        />
        <StatChip
          label="A raw bb/100"
          value={<span className={signClass(m.aRawBbPer100)}>{fmtBb(m.aRawBbPer100)}</span>}
        />
        <StatChip
          label="A dup-adj bb/100"
          value={
            <span className={signClass(m.aDupAdjBbPer100)}>{fmtBb(m.aDupAdjBbPer100)}</span>
          }
          sub="luck-cancelled"
        />
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="eyebrow">
            spot deltas vs this opponent — where {m.agentAName} loses (and wins) the exchange
          </p>
          <p className="text-[11px] text-ink3">mirror-differenced · negative = B outplays A there</p>
        </div>
        {deltas.length === 0 ? (
          <Empty
            title="No spot deltas for this matchup yet"
            hint="Spot deltas need completed mirror pairs with diverging lines."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="left">spot (position · street · texture · line)</th>
                  <th title="deck-sides whose first divergence was this spot">mirror n</th>
                  <th title="avg own minus counterpart result on the identical deck ×100">
                    mirror Δbb
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {deltas.map((d) => (
                  <tr key={`${d.position}|${d.street}|${d.board_texture}|${d.line}`}>
                    <td className="left font-mono text-xs text-ink2">
                      {d.position} · {d.street}
                      {d.board_texture !== "na" ? ` · ${d.board_texture}` : ""} · {d.line}
                    </td>
                    <td className="num text-ink3">{d.mirror_n}</td>
                    <td
                      className={`num font-medium ${d.mirror_n < 5 ? "opacity-40" : ""} ${signClass(d.mirror_delta_bb)}`}
                      title={d.mirror_n < 5 ? "very thin — directional at best" : undefined}
                    >
                      {fmtBb(d.mirror_delta_bb)}
                    </td>
                    <td>
                      <Link
                        href={`/hands?agentId=${a}&opponentId=${b}&street=${d.street}`}
                        className="font-mono text-[11px] text-ink3 hover:text-accent"
                      >
                        hands →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-[11px] text-ink3" title={m.lastUpdated}>
        refreshed {timeAgo(m.lastUpdated)}
      </p>
    </div>
  );
}
