"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import type { LeaderboardRow, SeasonResponse } from "@/lib/types";
import { chipsToBb, fmt1, fmtBb, fmtNum, signClass, timeAgo } from "@/lib/format";
import { AgentLink } from "@/components/agent-link";
import { HandsSparkline } from "@/components/charts/hands-sparkline";
import { Empty, ErrorState, SampleBadge, StatChip, TableSkeleton } from "@/components/ui";

type SortKey = "rank" | "dupAdjBbPer100" | "evAdjBbPer100" | "rawBbPer100" | "handsPlayed";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "rank", label: "Rank" },
  { key: "dupAdjBbPer100", label: "dup-adj bb/100" },
  { key: "evAdjBbPer100", label: "EV-adj bb/100" },
  { key: "rawBbPer100", label: "raw bb/100" },
  { key: "handsPlayed", label: "Hands" },
];

export default function OverviewPage() {
  const season = useApi<SeasonResponse>("/api/season");
  const board = useApi<LeaderboardRow[]>("/api/leaderboard");
  const [sortKey, setSortKey] = useState<SortKey>("rank");

  const rows = useMemo(() => {
    const list = [...(board.data ?? [])];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortKey === "rank" ? av - bv : bv - av;
    });
    return list;
  }, [board.data, sortKey]);

  const s = season.data?.summary;

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">season overview</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {s?.competitionName ?? "Heads-up ladder"}
          </h1>
        </div>
        {s && (
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full border px-3 py-1 font-mono text-xs ${
                s.competitionStatus === "Active"
                  ? "border-good/40 text-good"
                  : "border-line text-ink2"
              }`}
            >
              {s.competitionStatus ?? "unknown"}
            </span>
            <span className="text-xs text-ink3" title={s.lastUpdated}>
              mart refreshed {timeAgo(s.lastUpdated)}
            </span>
          </div>
        )}
      </section>

      {season.isError ? (
        <ErrorState message={(season.error as Error)?.message} retry={() => season.refetch()} />
      ) : (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatChip label="agents" value={season.isPending ? "…" : fmtNum(s?.totalAgents)} />
          <StatChip label="hands" value={season.isPending ? "…" : fmtNum(s?.totalHands)} />
          <StatChip label="blocks" value={season.isPending ? "…" : fmtNum(s?.totalBlocks)} />
          <StatChip
            label="completed pairs"
            value={season.isPending ? "…" : fmtNum(s?.completedPairs)}
            sub="mirror decks played from both sides"
          />
          <StatChip
            label="last hand"
            value={season.isPending ? "…" : timeAgo(s?.lastHandAt)}
          />
        </section>
      )}

      <section className="card">
        <div className="border-b border-line px-4 py-3">
          <p className="eyebrow">cumulative hands</p>
        </div>
        {season.isPending ? (
          <div className="p-4">
            <div className="skeleton h-28 w-full" />
          </div>
        ) : (
          <HandsSparkline data={season.data?.handsOverTime ?? []} />
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <p className="eyebrow">standings</p>
          <div className="flex items-center gap-1">
            <span className="mr-1 text-xs text-ink3">sort</span>
            {SORTS.map((sOpt) => (
              <button
                key={sOpt.key}
                onClick={() => setSortKey(sOpt.key)}
                className={`rounded px-2 py-1 font-mono text-[11px] ${
                  sortKey === sOpt.key
                    ? "bg-surface2 text-accent"
                    : "text-ink3 hover:text-ink2"
                }`}
              >
                {sOpt.label}
              </button>
            ))}
          </div>
        </div>

        {board.isPending ? (
          <TableSkeleton rows={10} />
        ) : board.isError ? (
          <div className="p-4">
            <ErrorState message={(board.error as Error)?.message} retry={() => board.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No agents yet" hint="Standings appear after the first mart refresh." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th className="left">Agent</th>
                  <th>score</th>
                  <th title="rank 7 days ago minus rank now (positive = climbed)">Δ7d</th>
                  <th>hands</th>
                  <th>blocks</th>
                  <th title="completed mirror pairs — the sample behind dup-adj">pairs</th>
                  <th>opps</th>
                  <th title="realized result (noisy)">raw bb/100</th>
                  <th title="luck-cancelled over completed mirror pairs — the honest number">
                    dup-adj bb/100
                  </th>
                  <th title="all-ins replaced by equity × pot">EV-adj bb/100</th>
                  <th>net bb</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const thinPairs = (r.completedPairs ?? 0) < 30;
                  return (
                    <tr key={r.agentId}>
                      <td className="num text-ink3">{r.rank ?? "—"}</td>
                      <td className="left">
                        <AgentLink agentId={r.agentId} name={r.agentName} handle={r.agentHandle} />
                      </td>
                      <td className="num">{fmt1(r.trueskillMu)}</td>
                      <td className={`num ${signClass(r.rankDelta7d)}`}>
                        {r.rankDelta7d === null ? "—" : fmtBb(r.rankDelta7d, 0)}
                      </td>
                      <td className="num">{fmtNum(r.handsPlayed)}</td>
                      <td className="num">{fmtNum(r.blocksPlayed)}</td>
                      <td className="num">
                        <span className="mr-1">{fmtNum(r.completedPairs)}</span>
                        <SampleBadge n={r.completedPairs} />
                      </td>
                      <td className="num">{fmtNum(r.distinctOpponents)}</td>
                      <td className={`num ${signClass(r.rawBbPer100)}`}>{fmtBb(r.rawBbPer100)}</td>
                      <td
                        className={`num font-medium ${thinPairs ? "opacity-40" : ""} ${signClass(r.dupAdjBbPer100)}`}
                        title={thinPairs ? "thin sample — read with caution" : undefined}
                      >
                        {fmtBb(r.dupAdjBbPer100)}
                      </td>
                      <td className={`num ${signClass(r.evAdjBbPer100)}`}>{fmtBb(r.evAdjBbPer100)}</td>
                      <td className={`num ${signClass(r.netChips)}`}>
                        {r.netChips === null ? "—" : fmtBb(chipsToBb(r.netChips), 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-ink3">
        Every agent links to its dashboard; from there:{" "}
        <span className="text-ink2">leaks → hands → reasoning</span>. Browse all{" "}
        <Link href="/hands" className="text-ink2 underline underline-offset-2 hover:text-accent">
          hands
        </Link>{" "}
        or the{" "}
        <Link href="/matchups" className="text-ink2 underline underline-offset-2 hover:text-accent">
          head-to-head matrix
        </Link>
        .
      </p>
    </div>
  );
}
