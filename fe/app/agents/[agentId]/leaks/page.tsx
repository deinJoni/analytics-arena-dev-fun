"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import type { AgentStatsResponse, LeakRow } from "@/lib/types";
import { fmtBb, signClass } from "@/lib/format";
import { LeakBars, handsHref, spotLabel } from "@/components/charts/leak-bars";
import { Empty, ErrorState, TableSkeleton } from "@/components/ui";

const STREET_OPTS = ["", "Preflop", "Flop", "Turn", "River"];
const POSITION_OPTS = ["", "IP", "OOP"];
const TEXTURE_OPTS = ["", "dry", "semi_wet", "wet", "na"];

type SortKey = "mirrorDeltaBb" | "bbPer100Spot" | "evBbPer100Spot" | "sampleN";

function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink3">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-line bg-surface2 px-2 py-1 font-mono text-xs text-ink"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o === "" ? "all" : o}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function LeaksPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  const [position, setPosition] = useState("");
  const [street, setStreet] = useState("");
  const [texture, setTexture] = useState("");
  const [minSampleN, setMinSampleN] = useState(30);
  const [sortKey, setSortKey] = useState<SortKey>("mirrorDeltaBb");

  const qs = new URLSearchParams();
  if (position) qs.set("position", position);
  if (street) qs.set("street", street);
  if (texture) qs.set("texture", texture);
  qs.set("minSampleN", String(minSampleN));

  const leaks = useApi<LeakRow[]>(`/api/agents/${agentId}/leaks?${qs.toString()}`);
  const agent = useApi<AgentStatsResponse>(`/api/agents/${agentId}/stats`);
  const name = agent.data?.header.agentName ?? agentId;

  const sorted = useMemo(() => {
    const list = [...(leaks.data ?? [])];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      // worst first for delta; biggest first for the rest
      return sortKey === "mirrorDeltaBb" ? av - bv : bv - av;
    });
    return list;
  }, [leaks.data, sortKey]);

  const th = (key: SortKey, label: string, title?: string) => (
    <th
      title={title}
      onClick={() => setSortKey(key)}
      className={`cursor-pointer select-none ${sortKey === key ? "!text-accent" : ""}`}
    >
      {label}
      {sortKey === key ? " ↓" : ""}
    </th>
  );

  return (
    <div className="space-y-6">
      <nav className="text-xs text-ink3">
        <Link href="/" className="hover:text-ink2">overview</Link>
        <span className="mx-1.5">/</span>
        <Link href={`/agents/${agentId}`} className="hover:text-ink2">{name}</Link>
        <span className="mx-1.5">/</span>
        <span className="text-ink2">leaks</span>
      </nav>

      <section>
        <p className="eyebrow">leak / ev attribution</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Where {name} bleeds chips
        </h1>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-ink3">
          <span className="text-ink2">mirror Δbb</span> compares each deck-side against the
          opponent who played the <em>identical cards</em> — duplicate-differenced, so a
          persistently negative bucket is a real leak, not card luck. Attribution to a spot is
          directional (a pair&apos;s delta lands on the spot where the two playings first
          diverge). Always read next to sample sizes.
        </p>
      </section>

      <section className="flex flex-wrap items-center gap-4">
        <Select label="position" value={position} onChange={setPosition} options={POSITION_OPTS} />
        <Select label="street" value={street} onChange={setStreet} options={STREET_OPTS} />
        <Select label="texture" value={texture} onChange={setTexture} options={TEXTURE_OPTS} />
        <label className="flex items-center gap-1.5 text-xs text-ink3">
          min sample
          <input
            type="number"
            min={1}
            value={minSampleN}
            onChange={(e) => setMinSampleN(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded border border-line bg-surface2 px-2 py-1 font-mono text-xs text-ink"
          />
        </label>
        {minSampleN > 1 && (
          <button
            onClick={() => setMinSampleN(1)}
            className="text-xs text-ink3 underline underline-offset-2 hover:text-ink2"
          >
            show thin spots too
          </button>
        )}
      </section>

      {leaks.isPending ? (
        <div className="card"><TableSkeleton rows={10} /></div>
      ) : leaks.isError ? (
        <ErrorState message={(leaks.error as Error)?.message} retry={() => leaks.refetch()} />
      ) : sorted.length === 0 ? (
        <Empty
          title="No spots match these filters"
          hint={`Try lowering min sample (currently ${minSampleN}) — early in a season most buckets are thin.`}
        />
      ) : (
        <>
          <section className="card">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="eyebrow">worst buckets by mirror Δbb</p>
              <p className="text-[11px] text-ink3">×n = deck-sides attributed · click a bar to see those hands</p>
            </div>
            <LeakBars rows={sorted} agentId={agentId} />
          </section>

          <section className="card overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <p className="eyebrow">all spots ({sorted.length})</p>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="left">spot (position · street · texture · line)</th>
                    {th("sampleN", "sample")}
                    {th("bbPer100Spot", "bb/100", "realized whole-hand result over hands with this line")}
                    {th("evBbPer100Spot", "EV bb/100", "all-in-EV-adjusted")}
                    {th("mirrorDeltaBb", "mirror Δbb", "avg own minus counterpart result on the identical deck ×100")}
                    <th>mirror n</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={`${r.position}|${r.street}|${r.boardTexture}|${r.line}`}>
                      <td className="left font-mono text-xs text-ink2">{spotLabel(r)}</td>
                      <td className="num">{r.sampleN}</td>
                      <td className={`num ${signClass(r.bbPer100Spot)}`}>{fmtBb(r.bbPer100Spot)}</td>
                      <td className={`num ${signClass(r.evBbPer100Spot)}`}>{fmtBb(r.evBbPer100Spot)}</td>
                      <td
                        className={`num font-medium ${r.mirrorN < 10 ? "opacity-40" : ""} ${signClass(r.mirrorDeltaBb)}`}
                        title={r.mirrorN < 10 ? "thin mirror sample" : undefined}
                      >
                        {fmtBb(r.mirrorDeltaBb)}
                      </td>
                      <td className="num text-ink3">{r.mirrorN}</td>
                      <td>
                        <Link
                          href={handsHref(agentId, r)}
                          className="font-mono text-[11px] text-ink3 hover:text-accent"
                          title="open the hand browser filtered to this agent and street"
                        >
                          hands →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="text-[11px] text-ink3">
            Deep links filter the browser to this agent and hands reaching that street —
            per-hand line filtering isn&apos;t in the mart yet.
          </p>
        </>
      )}
    </div>
  );
}
