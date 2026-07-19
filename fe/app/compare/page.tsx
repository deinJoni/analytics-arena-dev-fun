"use client";

import { Fragment, Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { UseQueryResult } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import type { AgentStatsResponse, AgentStatsSplit, LeaderboardRow } from "@/lib/types";
import { fmt1, fmtBb, fmtNum, fmtPct, signClass } from "@/lib/format";
import { AgentLink } from "@/components/agent-link";
import { SearchPalette } from "@/components/search-palette";
import { Skeleton, TableSkeleton } from "@/components/ui";

const MAX_AGENTS = 3;
// Same honesty bar as the agent dashboard: per-stat denominators below this
// grey out. (completedPairs uses the stricter 30, as on the profile page.)
const THIN = 20;
const THIN_PAIRS = 30;

type StatsQuery = UseQueryResult<AgentStatsResponse, Error>;

// Same stat rows, groups, and order as the agent dashboard stat table.
// `betterHigh` is set ONLY where direction is unambiguous (win rates) —
// VPIP/PFR/3-bet etc. are style, not quality, so they never get a "best" shade.
interface StatDef {
  label: string;
  title?: string;
  oppKey: string | null; // null -> fall back to sampleN
  value: (s: AgentStatsSplit) => number | null;
  fmt: (s: AgentStatsSplit) => string;
  betterHigh?: boolean;
}

const GROUPS: { name: string; stats: StatDef[] }[] = [
  {
    name: "Preflop",
    stats: [
      { label: "VPIP", oppKey: "hands", value: (s) => s.vpipPct, fmt: (s) => fmtPct(s.vpipPct) },
      { label: "PFR", oppKey: "hands", value: (s) => s.pfrPct, fmt: (s) => fmtPct(s.pfrPct) },
      { label: "3-bet", oppKey: "three_bet", value: (s) => s.threeBetPct, fmt: (s) => fmtPct(s.threeBetPct) },
      { label: "Fold to 3-bet", oppKey: "fold_to_three_bet", value: (s) => s.foldToThreeBetPct, fmt: (s) => fmtPct(s.foldToThreeBetPct) },
    ],
  },
  {
    name: "Postflop",
    stats: [
      { label: "C-bet flop", oppKey: "cbet_flop", value: (s) => s.cbetFlopPct, fmt: (s) => fmtPct(s.cbetFlopPct) },
      { label: "Fold to c-bet", oppKey: "fold_to_cbet_flop", value: (s) => s.foldToCbetFlopPct, fmt: (s) => fmtPct(s.foldToCbetFlopPct) },
      { label: "Barrel turn", title: "double-barrel %", oppKey: "cbet_turn", value: (s) => s.cbetTurnPct, fmt: (s) => fmtPct(s.cbetTurnPct) },
      { label: "Barrel river", title: "triple-barrel %", oppKey: "cbet_river", value: (s) => s.cbetRiverPct, fmt: (s) => fmtPct(s.cbetRiverPct) },
      { label: "Check-raise", oppKey: "check_raise", value: (s) => s.checkRaisePct, fmt: (s) => fmtPct(s.checkRaisePct) },
      { label: "Aggression factor", title: "(bets+raises)/calls postflop", oppKey: null, value: (s) => s.aggressionFactor, fmt: (s) => fmt1(s.aggressionFactor) },
      { label: "Aggression freq", oppKey: null, value: (s) => s.aggressionFreqPct, fmt: (s) => fmtPct(s.aggressionFreqPct) },
      { label: "Avg bet (pot)", oppKey: null, value: (s) => s.avgBetPotFraction, fmt: (s) => (s.avgBetPotFraction === null ? "—" : `${(s.avgBetPotFraction * 100).toFixed(0)}%`) },
    ],
  },
  {
    name: "Showdown",
    stats: [
      { label: "WTSD", title: "went to showdown, of hands that saw flop", oppKey: "saw_flop", value: (s) => s.wtsdPct, fmt: (s) => fmtPct(s.wtsdPct) },
      { label: "W$SD", title: "won money at showdown", oppKey: "wtsd", value: (s) => s.wsdPct, fmt: (s) => fmtPct(s.wsdPct), betterHigh: true },
      { label: "WWSF", title: "won when saw flop", oppKey: "saw_flop", value: (s) => s.wwsfPct, fmt: (s) => fmtPct(s.wwsfPct), betterHigh: true },
    ],
  },
];

function denomOf(def: StatDef, split: AgentStatsSplit): number {
  return def.oppKey ? (split.opportunities?.[def.oppKey] ?? 0) : split.sampleN;
}

// Highest non-null value among columns, or null when fewer than two columns
// have a value (a "best of one" says nothing) or the row isn't directional.
function bestValue(values: (number | null)[], directional: boolean | undefined): number | null {
  if (!directional) return null;
  const present = values.filter((v): v is number => v !== null);
  return present.length >= 2 ? Math.max(...present) : null;
}

function StatCell({
  def,
  split,
  best,
}: {
  def: StatDef;
  split: AgentStatsSplit | undefined;
  best: number | null;
}) {
  if (!split) return <td className="num text-ink3">—</td>;
  const denom = denomOf(def, split);
  const thin = denom < THIN;
  const isBest = best !== null && def.value(split) === best;
  return (
    <td
      className={`num ${isBest ? "bg-surface2" : ""} ${
        thin ? "text-ink3 opacity-60" : isBest ? "text-pos font-medium" : "text-ink"
      }`}
      title={thin ? `thin sample: ${denom} opportunities` : `${denom} opportunities`}
    >
      {def.fmt(split)}
      <span className="ml-1.5 text-[9px] text-ink3">{denom}</span>
    </td>
  );
}

function CardHeader({ agentId, header }: { agentId: string; header: LeaderboardRow }) {
  return (
    <>
      <p className="eyebrow">rank {header.rank !== null ? `#${header.rank}` : "—"}</p>
      <p className="mt-1 truncate pr-6 text-sm font-medium">
        <AgentLink agentId={agentId} name={header.agentName} handle={header.agentHandle} />
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink2">
        <span>
          score <span className="num text-ink">{fmt1(header.trueskillMu)}</span>
        </span>
        <span>
          dup-adj{" "}
          <span className={`num ${signClass(header.dupAdjBbPer100)}`}>
            {fmtBb(header.dupAdjBbPer100)}
          </span>{" "}
          bb/100
        </span>
        <span>
          <span className="num text-ink">{fmtNum(header.handsPlayed)}</span> hands
        </span>
      </div>
    </>
  );
}

function AgentCard({
  agentId,
  query,
  onRemove,
}: {
  agentId: string;
  query: StatsQuery;
  onRemove: () => void;
}) {
  return (
    <div className="card relative p-4">
      <button
        onClick={onRemove}
        aria-label="Remove from comparison"
        title="Remove from comparison"
        className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-ink3 hover:bg-surface2 hover:text-ink"
      >
        ✕
      </button>
      {query.isPending ? (
        <div className="space-y-2" role="status" aria-label="Loading agent">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3 w-44" />
        </div>
      ) : query.isError ? (
        <>
          <p className="font-mono text-xs text-ink3">…{agentId.slice(-8)}</p>
          <p className="mt-2 pr-6 text-xs text-neg/80">
            Couldn’t load this agent
            {query.error?.message ? ` — ${query.error.message}` : "."}
          </p>
          <button
            onClick={() => query.refetch()}
            className="mt-2 rounded border border-line bg-surface2 px-2 py-1 text-xs text-ink hover:border-accent"
          >
            Retry
          </button>
        </>
      ) : (
        <CardHeader agentId={agentId} header={query.data.header} />
      )}
    </div>
  );
}

function CompareView() {
  const router = useRouter();
  const sp = useSearchParams();
  const [pickerOpen, setPickerOpen] = useState(false);

  // The comparison lives in the URL so it's deep-linkable.
  const ids = useMemo(() => {
    const out: string[] = [];
    for (const part of (sp.get("agents") ?? "").split(",")) {
      const id = part.trim();
      if (id && !out.includes(id)) out.push(id);
      if (out.length === MAX_AGENTS) break;
    }
    return out;
  }, [sp]);

  const setAgents = (next: string[]) => {
    const params = new URLSearchParams(sp.toString());
    if (next.length) params.set("agents", next.join(","));
    else params.delete("agents");
    const qs = params.toString();
    router.replace(qs ? `/compare?${qs}` : "/compare");
  };

  // One fixed hook per slot (max 3), skipped with null when the slot is empty.
  const q0 = useApi<AgentStatsResponse>(ids[0] ? `/api/agents/${ids[0]}/stats` : null);
  const q1 = useApi<AgentStatsResponse>(ids[1] ? `/api/agents/${ids[1]}/stats` : null);
  const q2 = useApi<AgentStatsResponse>(ids[2] ? `/api/agents/${ids[2]}/stats` : null);
  const cols = ids.map((id, i) => ({ id, query: [q0, q1, q2][i] }));
  const splitOf = (q: StatsQuery) => q.data?.splits.find((s) => s.position === "ALL");
  const headerOf = (q: StatsQuery) => q.data?.header;

  const allPending = cols.length > 0 && cols.every((c) => c.query.isPending);

  // Result-row helpers (directional rows only get the "best" shade).
  const rawVals = cols.map((c) => splitOf(c.query)?.bbPer100 ?? null);
  const rawBest = bestValue(rawVals, true);
  const dupVals = cols.map((c) => headerOf(c.query)?.dupAdjBbPer100 ?? null);
  const dupBest = bestValue(dupVals, true);

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow">head-to-head</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Compare agents</h1>
        <p className="mt-1 text-xs text-ink3">
          the full stat line, side by side — how they play up top, what they win at the bottom.
          shaded cell = best of the selection (win-rate rows only); greyed = thin sample.
        </p>
      </section>

      {ids.length === 0 ? (
        <div className="card flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-ink2">Pick two or three agents to compare.</p>
          <p className="text-xs text-ink3">
            Their stat lines line up side by side — style stats above, luck-cancelled results below.
          </p>
          <button
            onClick={() => setPickerOpen(true)}
            className="rounded border border-line bg-surface2 px-3 py-1.5 text-sm text-ink hover:border-accent"
          >
            Choose agents
          </button>
        </div>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cols.map((c) => (
              <AgentCard
                key={c.id}
                agentId={c.id}
                query={c.query}
                onRemove={() => setAgents(ids.filter((id) => id !== c.id))}
              />
            ))}
            {ids.length < MAX_AGENTS && (
              <button
                onClick={() => setPickerOpen(true)}
                className="card flex min-h-[104px] flex-col items-center justify-center gap-1 border-dashed p-4 text-ink3 hover:border-accent hover:text-ink2"
              >
                <span className="text-lg leading-none">+</span>
                <span className="text-xs">add agent</span>
              </button>
            )}
          </section>

          {allPending ? (
            <div className="card">
              <TableSkeleton rows={12} />
            </div>
          ) : (
            <section className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <p className="eyebrow">stat line — all positions</p>
                <p className="text-[11px] text-ink3">
                  small number beside each stat = its true denominator; greyed = fewer than {THIN}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="left">stat</th>
                      {cols.map((c) => {
                        const h = headerOf(c.query);
                        return (
                          <th key={c.id} className="normal-case">
                            {c.query.isPending ? (
                              <span className="text-ink3">loading…</span>
                            ) : c.query.isError ? (
                              <span className="text-neg/80">load failed</span>
                            ) : (
                              <>
                                <AgentLink
                                  agentId={c.id}
                                  name={h?.agentName ?? null}
                                  className="text-xs font-medium tracking-normal"
                                />
                                <span className="ml-1.5 font-normal tracking-normal text-ink3">
                                  {h?.rank !== null && h?.rank !== undefined
                                    ? `#${h.rank}`
                                    : "—"}
                                </span>
                              </>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {GROUPS.map((g) => (
                      <Fragment key={g.name}>
                        <tr>
                          <td colSpan={cols.length + 1} className="left !border-b-0 pt-4">
                            <span className="eyebrow text-accent/80">{g.name}</span>
                          </td>
                        </tr>
                        {g.stats.map((def) => {
                          const best = bestValue(
                            cols.map((c) => {
                              const s = splitOf(c.query);
                              return s ? def.value(s) : null;
                            }),
                            def.betterHigh,
                          );
                          return (
                            <tr key={def.label}>
                              <td className="left text-ink2" title={def.title}>
                                {def.label}
                              </td>
                              {cols.map((c) => (
                                <StatCell
                                  key={c.id}
                                  def={def}
                                  split={splitOf(c.query)}
                                  best={best}
                                />
                              ))}
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                    <tr>
                      <td colSpan={cols.length + 1} className="left !border-b-0 pt-4">
                        <span className="eyebrow text-accent/80">Result</span>
                      </td>
                    </tr>
                    <tr>
                      <td className="left text-ink2" title="raw big blinds won per 100 hands">
                        bb/100 (raw)
                      </td>
                      {cols.map((c, i) => {
                        const v = rawVals[i];
                        return (
                          <td
                            key={c.id}
                            className={`num font-medium ${
                              rawBest !== null && v === rawBest ? "bg-surface2" : ""
                            } ${signClass(v)}`}
                          >
                            {fmtBb(v)}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td
                        className="left text-ink2"
                        title="luck-cancelled win rate over completed mirror pairs"
                      >
                        dup-adj bb/100
                      </td>
                      {cols.map((c, i) => {
                        const h = headerOf(c.query);
                        const v = dupVals[i];
                        const pairs = h?.completedPairs ?? 0;
                        const thin = !h || pairs < THIN_PAIRS;
                        const isBest = dupBest !== null && v === dupBest;
                        return (
                          <td
                            key={c.id}
                            className={`num font-medium ${isBest ? "bg-surface2" : ""} ${
                              thin ? "text-ink3 opacity-60" : signClass(v)
                            }`}
                            title={
                              thin
                                ? `thin sample: ${pairs} completed pairs`
                                : `${pairs} completed pairs`
                            }
                          >
                            {fmtBb(v)}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {pickerOpen && (
        <SearchPalette
          open
          onOpenChange={setPickerOpen}
          onSelect={(row) => {
            if (!ids.includes(row.agentId)) setAgents([...ids, row.agentId]);
          }}
        />
      )}
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="card">
          <TableSkeleton rows={12} />
        </div>
      }
    >
      <CompareView />
    </Suspense>
  );
}
