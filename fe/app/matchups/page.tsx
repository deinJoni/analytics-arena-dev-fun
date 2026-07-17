"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/api";
import type { MatchupCell } from "@/lib/types";
import { fmtBb, fmtNum, fmtPct, signClass } from "@/lib/format";
import { MatchupMatrix, type MatrixAgent } from "@/components/charts/matchup-matrix";
import { Empty, ErrorState, TableSkeleton } from "@/components/ui";

const CAPS = [10, 20] as const;

function MatchupsView() {
  const sp = useSearchParams();
  const focusId = sp.get("focus");
  const matchups = useApi<MatchupCell[]>("/api/matchups");
  const [cap, setCap] = useState<number>(20);

  const agents = useMemo<MatrixAgent[]>(() => {
    const seen = new Map<string, MatrixAgent>();
    for (const c of matchups.data ?? []) {
      if (!seen.has(c.agentAId)) {
        seen.set(c.agentAId, {
          agentId: c.agentAId,
          name: c.agentAName ?? c.agentAId.slice(-8),
          rank: c.agentARank,
        });
      }
      if (!seen.has(c.agentBId)) {
        seen.set(c.agentBId, {
          agentId: c.agentBId,
          name: c.agentBName ?? c.agentBId.slice(-8),
          rank: c.agentBRank,
        });
      }
    }
    const list = [...seen.values()].sort(
      (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity),
    );
    const kept = list.slice(0, cap);
    // the focused agent always stays visible
    if (focusId && !kept.some((a) => a.agentId === focusId)) {
      const f = list.find((a) => a.agentId === focusId);
      if (f) kept.push(f);
    }
    return kept;
  }, [matchups.data, cap, focusId]);

  const tableRows = useMemo(() => {
    let rows = [...(matchups.data ?? [])];
    if (focusId) rows = rows.filter((c) => c.agentAId === focusId);
    rows.sort((a, b) => (b.aDupAdjBbPer100 ?? -Infinity) - (a.aDupAdjBbPer100 ?? -Infinity));
    return rows.slice(0, 200);
  }, [matchups.data, focusId]);

  const focusName =
    focusId &&
    (agents.find((a) => a.agentId === focusId)?.name ?? focusId.slice(-8));

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">head-to-head</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Who exploits whom
          </h1>
          <p className="mt-1 text-xs text-ink3">
            dup-adj bb/100 per matchup — luck-cancelled over completed mirror pairs, zero-sum by
            construction. Click a cell for the spot breakdown.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-ink3">agents</span>
          {CAPS.map((c) => (
            <button
              key={c}
              onClick={() => setCap(c)}
              className={`rounded px-2 py-1 font-mono text-[11px] ${
                cap === c ? "bg-surface2 text-accent" : "text-ink3 hover:text-ink2"
              }`}
            >
              top {c}
            </button>
          ))}
        </div>
      </section>

      {focusId && (
        <p className="text-xs text-ink2">
          focused on <span className="text-accent">{focusName}</span>{" "}
          <Link href="/matchups" className="text-ink3 underline underline-offset-2 hover:text-ink2">
            clear
          </Link>
        </p>
      )}

      {matchups.isPending ? (
        <div className="card"><TableSkeleton rows={12} /></div>
      ) : matchups.isError ? (
        <ErrorState message={(matchups.error as Error)?.message} retry={() => matchups.refetch()} />
      ) : agents.length === 0 ? (
        <Empty title="No matchups yet" hint="Matchups appear once blocks complete." />
      ) : (
        <>
          <section className="card overflow-hidden">
            <MatchupMatrix agents={agents} cells={matchups.data} focusId={focusId} />
          </section>

          <section className="card overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <p className="eyebrow">
                {focusName ? `${focusName} — all opponents` : "strongest edges"}
              </p>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th className="left">A</th>
                  <th className="left">B</th>
                  <th title="completed mirror pairs — the sample behind dup-adj">pairs</th>
                  <th title="share of hands A won chips in">A win %</th>
                  <th title="the honest, luck-cancelled number">A dup-adj</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((c) => {
                  const thin = (c.completedPairs ?? 0) < 10;
                  return (
                    <tr key={`${c.agentAId}|${c.agentBId}`}>
                      <td className="left max-w-32 truncate sm:max-w-none">
                        <Link href={`/agents/${c.agentAId}`} className="hover:text-accent">
                          {c.agentAName}
                        </Link>
                      </td>
                      <td className="left max-w-32 truncate sm:max-w-none">
                        <Link href={`/agents/${c.agentBId}`} className="hover:text-accent">
                          {c.agentBName}
                        </Link>
                      </td>
                      <td className="num">{fmtNum(c.completedPairs)}</td>
                      <td className="num">
                        {c.aWinRate === null ? "—" : fmtPct(c.aWinRate * 100, 0)}
                      </td>
                      <td
                        className={`num font-medium ${thin ? "opacity-40" : ""} ${signClass(c.aDupAdjBbPer100)}`}
                        title={thin ? "thin sample" : undefined}
                      >
                        {fmtBb(c.aDupAdjBbPer100)}
                      </td>
                      <td>
                        <Link
                          href={`/matchups/${c.agentAId}/${c.agentBId}`}
                          className="font-mono text-[11px] text-ink3 hover:text-accent"
                        >
                          detail →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

export default function MatchupsPage() {
  return (
    <Suspense fallback={<div className="card"><TableSkeleton rows={12} /></div>}>
      <MatchupsView />
    </Suspense>
  );
}
