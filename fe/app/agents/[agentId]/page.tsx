"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Fragment, use, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import type {
  AgentStatsResponse,
  AgentStatsSplit,
  RangeCombo,
  RankHistoryResponse,
  SizingSplit,
} from "@/lib/types";
import type { AgentPerformanceHistoryResponse } from "@/lib/queries/agentPerformanceHistory";
import { chipsToBb, fmt1, fmtBb, fmtNum, fmtPct, signClass } from "@/lib/format";
import type { SparkPoint } from "@/components/charts/stat-sparkline";
import { Empty, ErrorState, StatChip, TableSkeleton } from "@/components/ui";

// Below-the-fold heavy charts are code-split out of the initial client bundle:
// recharts (via StatSparkline) and the 13×13 range grids stream in behind
// skeletons matching each section's own pending state. ssr:false is allowed
// because this page is a Client Component, and these sections could never
// prerender anyway — they gate on client-fetched data.
const StatSparkline = dynamic(
  () => import("@/components/charts/stat-sparkline").then((m) => m.StatSparkline),
  { ssr: false, loading: () => <div className="skeleton h-32 w-full" /> },
);
const SizingBreakdown = dynamic(
  () => import("@/components/charts/sizing-histogram").then((m) => m.SizingBreakdown),
  { ssr: false, loading: () => <div className="skeleton h-48 w-full" /> },
);
const RangeStrategyGrid = dynamic(
  () => import("@/components/charts/range-grid").then((m) => m.RangeStrategyGrid),
  {
    ssr: false,
    loading: () => (
      <div className="min-w-0 flex-1">
        <div className="skeleton h-72 w-full max-w-[380px]" />
      </div>
    ),
  },
);
const RangeInfoPanel = dynamic(
  () => import("@/components/charts/range-grid").then((m) => m.RangeInfoPanel),
  { ssr: false, loading: () => <div className="skeleton h-72 w-full lg:w-64 lg:shrink-0" /> },
);

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
      <span className="ml-1 text-[8px] text-ink3 sm:ml-1.5 sm:text-[9px]">{denom}</span>
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
    <section className="card p-3 sm:p-4">
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

// One sparkline cell of the Trends grid: eyebrow label, then skeleton /
// error / honest-empty / chart. Fewer than 2 non-null points is the empty
// state (same honesty rule as RankTrajectory) — a one-dot line is noise.
function TrendCell({
  label,
  note,
  pending,
  isError,
  data,
  formatValue,
  color,
}: {
  label: string;
  note?: string;
  pending: boolean;
  isError: boolean;
  data: SparkPoint[];
  formatValue?: (v: number) => string;
  color?: string;
}) {
  const plottable = data.filter((p) => p.v !== null).length;
  return (
    <div>
      <p className="eyebrow" title={note}>
        {label}
      </p>
      {pending ? (
        <div className="skeleton mt-2 h-32 w-full" />
      ) : isError ? (
        <p className="py-4 text-center text-xs text-neg/80">
          Couldn’t load {label} trend.
        </p>
      ) : plottable < 2 ? (
        <p className="py-4 text-center text-xs text-ink3">
          No {label} history yet — fills in as the pipeline runs.
        </p>
      ) : (
        <StatSparkline
          data={data}
          label={label}
          formatValue={formatValue}
          color={color}
        />
      )}
    </div>
  );
}

// "Is this bot improving or decaying?" — score + rank from mart.rank_history
// (hourly snapshots), dup-adj bb/100 from mart.agent_daily_performance (daily,
// empty until the transform has built the mart). Each cell degrades on its own.
function TrendsSection({ agentId }: { agentId: string }) {
  const rankHistory = useApi<RankHistoryResponse>(
    `/api/agents/${agentId}/rank-history`,
  );
  const perf = useApi<AgentPerformanceHistoryResponse>(
    `/api/agents/${agentId}/performance-history`,
  );

  const rankPoints = rankHistory.data?.points ?? [];
  const scoreData: SparkPoint[] = rankPoints
    .filter((p) => p.totalScore !== null)
    .map((p) => ({ t: p.capturedAt, v: p.totalScore }));
  const rankData: SparkPoint[] = rankPoints
    .filter((p) => p.rank !== null)
    .map((p) => ({ t: p.capturedAt, v: p.rank }));
  const dupData: SparkPoint[] = (perf.data?.points ?? []).map((p) => ({
    t: p.day,
    v: p.dupAdjBb100Cum,
  }));

  return (
    <section className="card p-4">
      <p className="eyebrow mb-3">trends</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TrendCell
          label="score"
          note="ladder totalScore over time"
          pending={rankHistory.isPending}
          isError={rankHistory.isError}
          data={scoreData}
          formatValue={(v) => fmt1(v)}
        />
        <TrendCell
          label="rank"
          note="lower is better"
          pending={rankHistory.isPending}
          isError={rankHistory.isError}
          data={rankData}
          formatValue={(v) => `#${v}`}
          color="#3987e5"
        />
        <TrendCell
          label="dup-adj bb/100"
          note="luck-cancelled win rate, cumulative by day"
          pending={perf.isPending}
          isError={perf.isError}
          data={dupData}
          formatValue={(v) => fmtBb(v)}
        />
      </div>
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

      <TrendsSection agentId={agentId} />

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
              {/* Compresses below sm (tighter cells, smaller denominators) so ALL/IP/OOP
                  fit at 390px; overflow-x stays as the fallback. */}
              <table className="data-table max-sm:text-xs max-sm:[&_td]:px-1.5 max-sm:[&_th]:px-1.5">
                <thead>
                  <tr>
                    <th className="left">stat</th>
                    {positions.map((p) => {
                      const s = byPos.get(p);
                      return (
                        <th key={p}>
                          {p}
                          <span className="ml-1 font-normal normal-case tracking-normal text-ink3 sm:ml-1.5">
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
