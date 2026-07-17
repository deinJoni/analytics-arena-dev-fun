"use client";

import Link from "next/link";
import { Fragment, use, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import type { AgentStatsResponse, AgentStatsSplit, RangeCombo, SizingSplit } from "@/lib/types";
import { chipsToBb, fmt1, fmtBb, fmtNum, fmtPct, signClass } from "@/lib/format";
import { SizingBreakdown } from "@/components/charts/sizing-histogram";
import { RangeInfoPanel, RangeStrategyGrid } from "@/components/charts/range-grid";
import { Empty, ErrorState, StatChip, TableSkeleton } from "@/components/ui";

// Each stat row knows its true denominator key in `opportunities`,
// so thin splits grey out honestly (PRD: first-class UI state).
interface StatDef {
  label: string;
  title?: string;
  oppKey: string | null; // null -> fall back to sample_n
  fmt: (s: AgentStatsSplit) => string;
}

const GROUPS: { name: string; stats: StatDef[] }[] = [
  {
    name: "Preflop",
    stats: [
      { label: "VPIP", oppKey: "hands", fmt: (s) => fmtPct(s.vpipPct) },
      { label: "PFR", oppKey: "hands", fmt: (s) => fmtPct(s.pfrPct) },
      { label: "3-bet", oppKey: "three_bet", fmt: (s) => fmtPct(s.threeBetPct) },
      { label: "Fold to 3-bet", oppKey: "fold_to_three_bet", fmt: (s) => fmtPct(s.foldToThreeBetPct) },
    ],
  },
  {
    name: "Postflop",
    stats: [
      { label: "C-bet flop", oppKey: "cbet_flop", fmt: (s) => fmtPct(s.cbetFlopPct) },
      { label: "Fold to c-bet", oppKey: "fold_to_cbet_flop", fmt: (s) => fmtPct(s.foldToCbetFlopPct) },
      { label: "Barrel turn", title: "double-barrel %", oppKey: "cbet_turn", fmt: (s) => fmtPct(s.cbetTurnPct) },
      { label: "Barrel river", title: "triple-barrel %", oppKey: "cbet_river", fmt: (s) => fmtPct(s.cbetRiverPct) },
      { label: "Check-raise", oppKey: "check_raise", fmt: (s) => fmtPct(s.checkRaisePct) },
      { label: "Aggression factor", title: "(bets+raises)/calls postflop", oppKey: null, fmt: (s) => fmt1(s.aggressionFactor) },
      { label: "Aggression freq", oppKey: null, fmt: (s) => fmtPct(s.aggressionFreqPct) },
      { label: "Avg bet (pot)", oppKey: null, fmt: (s) => (s.avgBetPotFraction === null ? "—" : `${(s.avgBetPotFraction * 100).toFixed(0)}%`) },
    ],
  },
  {
    name: "Showdown",
    stats: [
      { label: "WTSD", title: "went to showdown, of hands that saw flop", oppKey: "saw_flop", fmt: (s) => fmtPct(s.wtsdPct) },
      { label: "W$SD", title: "won money at showdown", oppKey: "wtsd", fmt: (s) => fmtPct(s.wsdPct) },
      { label: "WWSF", title: "won when saw flop", oppKey: "saw_flop", fmt: (s) => fmtPct(s.wwsfPct) },
    ],
  },
];

const THIN = 20;

function StatCell({ def, split }: { def: StatDef; split: AgentStatsSplit | undefined }) {
  if (!split) return <td className="num text-ink3">—</td>;
  const denom = def.oppKey ? (split.opportunities?.[def.oppKey] ?? 0) : split.sampleN;
  const thin = denom < THIN;
  return (
    <td
      className={`num ${thin ? "text-ink3 opacity-60" : "text-ink"}`}
      title={thin ? `thin sample: ${denom} opportunities` : `${denom} opportunities`}
    >
      {def.fmt(split)}
      <span className="ml-1.5 text-[9px] text-ink3">{denom}</span>
    </td>
  );
}

function RangeSection({ agentId }: { agentId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const range = useApi<RangeCombo[]>(`/api/agents/${agentId}/range`);
  const combos = useMemo(
    () => new Map((range.data ?? []).map((c) => [c.hand, c])),
    [range.data],
  );

  return (
    <section className="card p-4">
      <p className="eyebrow mb-3">preflop strategy — 13×13</p>
      {range.isPending ? (
        <div className="skeleton h-72 w-full" />
      ) : range.isError ? (
        <ErrorState message={(range.error as Error)?.message} retry={() => range.refetch()} />
      ) : combos.size === 0 ? (
        <Empty title="No hands for this agent yet" />
      ) : (
        <div
          className="flex flex-col gap-6 lg:flex-row"
          onMouseLeave={() => setSelected(null)}
        >
          <RangeStrategyGrid
            combos={combos}
            node="ip_first"
            selected={selected}
            onSelect={setSelected}
          />
          <RangeStrategyGrid
            combos={combos}
            node="oop_vs_open"
            selected={selected}
            onSelect={setSelected}
          />
          <RangeInfoPanel combos={combos} selected={selected} />
        </div>
      )}
    </section>
  );
}

function SizingSection({ agentId }: { agentId: string }) {
  const sizing = useApi<SizingSplit[]>(`/api/agents/${agentId}/sizing`);
  return (
    <section className="card p-4">
      <p className="eyebrow mb-3">bet sizing — % of pot, by street and position</p>
      {sizing.isPending ? (
        <div className="skeleton h-48 w-full" />
      ) : sizing.isError ? (
        <ErrorState message={(sizing.error as Error)?.message} retry={() => sizing.refetch()} />
      ) : (
        <div className="max-w-2xl">
          <SizingBreakdown splits={sizing.data} />
        </div>
      )}
    </section>
  );
}

export default function AgentDashboard({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  const stats = useApi<AgentStatsResponse>(`/api/agents/${agentId}/stats`);

  if (stats.isPending) {
    return (
      <div className="card">
        <TableSkeleton rows={12} />
      </div>
    );
  }
  if (stats.isError) {
    return <ErrorState message={(stats.error as Error)?.message} retry={() => stats.refetch()} />;
  }

  const { header, splits } = stats.data;
  const byPos = new Map(splits.map((s) => [s.position, s]));
  const positions: ("ALL" | "IP" | "OOP")[] = ["ALL", "IP", "OOP"];

  return (
    <div className="space-y-6">
      <nav className="text-xs text-ink3">
        <Link href="/" className="hover:text-ink2">overview</Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink2">{header.agentName ?? agentId}</span>
      </nav>

      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">agent dashboard</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {header.agentName ?? "unnamed agent"}
            {header.agentHandle && (
              <span className="ml-2 text-base font-normal text-ink3">@{header.agentHandle}</span>
            )}
          </h1>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/agents/${agentId}/leaks`}
            className="rounded border border-accent/50 bg-surface2 px-4 py-2 text-sm font-medium text-accent hover:border-accent"
          >
            Leak map →
          </Link>
          <Link
            href={`/matchups?focus=${agentId}`}
            className="rounded border border-line bg-surface2 px-4 py-2 text-sm text-ink2 hover:border-accent hover:text-ink"
          >
            Head-to-head
          </Link>
          <Link
            href={`/hands?agentId=${agentId}`}
            className="rounded border border-line bg-surface2 px-4 py-2 text-sm text-ink2 hover:border-accent hover:text-ink"
          >
            Hands
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <StatChip label="rank" value={header.rank ?? "—"} />
        <StatChip label="score" value={fmt1(header.trueskillMu)} />
        <StatChip label="hands" value={fmtNum(header.handsPlayed)} />
        <StatChip
          label="pairs"
          value={fmtNum(header.completedPairs)}
          sub={(header.completedPairs ?? 0) < 30 ? "thin sample" : undefined}
        />
        <StatChip
          label="dup-adj bb/100"
          value={
            <span className={signClass(header.dupAdjBbPer100)}>{fmtBb(header.dupAdjBbPer100)}</span>
          }
          sub="luck-cancelled"
        />
        <StatChip
          label="net bb"
          value={
            <span className={signClass(header.netChips)}>
              {header.netChips === null ? "—" : fmtBb(chipsToBb(header.netChips), 0)}
            </span>
          }
        />
      </section>

      {splits.length === 0 ? (
        <Empty
          title="No stat splits for this agent yet"
          hint="Splits are computed by the transform once the agent has played hands."
        />
      ) : (
        <>
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="eyebrow">stat line — by position</p>
              <p className="text-[11px] text-ink3">
                small number beside each stat = its true denominator; greyed = fewer than {THIN}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="left">stat</th>
                    {positions.map((p) => {
                      const s = byPos.get(p);
                      return (
                        <th key={p}>
                          {p}
                          <span className="ml-1.5 font-normal normal-case tracking-normal text-ink3">
                            {s ? `${s.sampleN}h` : "0h"}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map((g) => (
                    <Fragment key={g.name}>
                      <tr>
                        <td colSpan={4} className="left !border-b-0 pt-4">
                          <span className="eyebrow text-accent/80">{g.name}</span>
                        </td>
                      </tr>
                      {g.stats.map((def) => (
                        <tr key={def.label}>
                          <td className="left text-ink2" title={def.title}>
                            {def.label}
                          </td>
                          {positions.map((p) => (
                            <StatCell key={p} def={def} split={byPos.get(p)} />
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr>
                    <td colSpan={4} className="left !border-b-0 pt-4">
                      <span className="eyebrow text-accent/80">Result</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="left text-ink2">bb/100 (raw)</td>
                    {positions.map((p) => {
                      const s = byPos.get(p);
                      return (
                        <td key={p} className={`num font-medium ${signClass(s?.bbPer100)}`}>
                          {fmtBb(s?.bbPer100 ?? null)}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <RangeSection agentId={agentId} />

          <SizingSection agentId={agentId} />
        </>
      )}
    </div>
  );
}
