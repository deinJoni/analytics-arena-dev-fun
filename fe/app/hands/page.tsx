"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { fetchJson, useApi } from "@/lib/api";
import type { HandsResponse, LeaderboardRow } from "@/lib/types";
import { chipsToBb, fmtBb, fmtTime, signClass } from "@/lib/format";
import { CardRow } from "@/components/playing-card";
import { Empty, ErrorState, TableSkeleton } from "@/components/ui";

const STREET_OPTS = ["", "Flop", "Turn", "River", "Showdown"];

function AgentSelect({
  label,
  value,
  onChange,
  agents,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  agents: LeaderboardRow[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink3">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-44 rounded border border-line bg-surface2 px-2 py-1 font-mono text-xs text-ink"
      >
        <option value="">any</option>
        {agents.map((a) => (
          <option key={a.agentId} value={a.agentId}>
            {a.agentName ?? a.agentId.slice(-8)}
          </option>
        ))}
      </select>
    </label>
  );
}

function HandsBrowser() {
  const router = useRouter();
  const sp = useSearchParams();

  // Filters live in the URL so leak rows / matchup pages can deep-link here.
  const agentId = sp.get("agentId") ?? "";
  const opponentId = sp.get("opponentId") ?? "";
  const street = sp.get("street") ?? "";
  const [minPotBb, setMinPotBb] = useState(sp.get("minPotBb") ?? "");
  const showdownOnly = sp.get("showdownOnly") === "true";
  const mirrorOnly = sp.get("mirrorOnly") === "true";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/hands?${next.toString()}`);
  };

  const board = useApi<LeaderboardRow[]>("/api/leaderboard");
  const agents = useMemo(
    () =>
      [...(board.data ?? [])].sort((a, b) =>
        (a.agentName ?? "").localeCompare(b.agentName ?? ""),
      ),
    [board.data],
  );

  const apiQs = new URLSearchParams();
  if (agentId) apiQs.set("agentId", agentId);
  if (opponentId) apiQs.set("opponentId", opponentId);
  if (street) apiQs.set("street", street);
  if (minPotBb) apiQs.set("minPotBb", minPotBb);
  if (showdownOnly) apiQs.set("showdownOnly", "true");
  if (mirrorOnly) apiQs.set("mirrorOnly", "true");
  apiQs.set("limit", "50");
  const baseQs = apiQs.toString();

  // CSV export of the same filtered result set (server caps at 5,000 rows).
  const exportQs = new URLSearchParams(apiQs);
  exportQs.delete("limit");
  const exportHref = `/api/hands/export?${exportQs.toString()}`;

  const hands = useInfiniteQuery({
    queryKey: ["hands", baseQs],
    queryFn: ({ pageParam }) =>
      fetchJson<HandsResponse>(
        `/api/hands?${baseQs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const allRows = hands.data?.pages.flatMap((p) => p.hands) ?? [];

  // Windowing: thousands of rows can accumulate via "load more", so only the
  // visible slice (+overscan) is in the DOM. Rows stay plain <tr> in native
  // table layout — top/bottom spacer rows supply the missing height — so the
  // .data-table look (auto column sizing, borders, hover, nowrap) and the
  // responsive column-hiding classes are untouched. Rows are uniform height
  // (22px card + 7px+7px padding + 1px border = 37px); measureElement keeps
  // the estimate honest.
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const rowVirtualizer = useWindowVirtualizer<HTMLTableRowElement>({
    count: allRows.length,
    estimateSize: () => 37,
    overscan: 10,
    scrollMargin,
  });

  const showTable = !hands.isPending && !hands.isError && allRows.length > 0;

  // The list scrolls with the window, so the virtualizer needs the tbody's
  // document offset as its scrollMargin. Re-measured whenever the table
  // (re)mounts — a filter change swaps it for the skeleton and back — and on
  // resize, since the wrapping filter bar can move the table.
  useEffect(() => {
    if (!showTable) return;
    const el = tbodyRef.current;
    if (!el) return;
    const update = () => {
      const next = el.getBoundingClientRect().top + window.scrollY;
      setScrollMargin((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [showTable]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const padTop = virtualRows.length > 0 ? virtualRows[0].start - scrollMargin : 0;
  const padBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1].end - scrollMargin)
      : 0;

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow">hand browser</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Hands</h1>
      </section>

      <section className="flex flex-wrap items-center gap-4">
        <AgentSelect
          label="agent"
          value={agentId}
          onChange={(v) => setParam("agentId", v)}
          agents={agents}
        />
        <AgentSelect
          label="opponent"
          value={opponentId}
          onChange={(v) => setParam("opponentId", v)}
          agents={agents}
        />
        <label className="flex items-center gap-1.5 text-xs text-ink3">
          reached ≥
          <select
            value={street}
            onChange={(e) => setParam("street", e.target.value)}
            className="rounded border border-line bg-surface2 px-2 py-1 font-mono text-xs text-ink"
          >
            {STREET_OPTS.map((o) => (
              <option key={o} value={o}>
                {o === "" ? "any street" : o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink3">
          pot ≥
          <input
            type="number"
            min={0}
            placeholder="bb"
            value={minPotBb}
            onChange={(e) => setMinPotBb(e.target.value)}
            onBlur={() => setParam("minPotBb", minPotBb)}
            onKeyDown={(e) => e.key === "Enter" && setParam("minPotBb", minPotBb)}
            className="w-16 rounded border border-line bg-surface2 px-2 py-1 font-mono text-xs text-ink"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink3">
          <input
            type="checkbox"
            checked={showdownOnly}
            onChange={(e) => setParam("showdownOnly", e.target.checked ? "true" : "")}
            className="accent-[#cfa04d]"
          />
          showdown only
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink3">
          <input
            type="checkbox"
            checked={mirrorOnly}
            onChange={(e) => setParam("mirrorOnly", e.target.checked ? "true" : "")}
            className="accent-[#cfa04d]"
          />
          has mirror
        </label>
        {(agentId || opponentId || street || minPotBb || showdownOnly || mirrorOnly) && (
          <button
            onClick={() => {
              setMinPotBb("");
              router.replace("/hands");
            }}
            className="text-xs text-ink3 underline underline-offset-2 hover:text-ink2"
          >
            clear filters
          </button>
        )}
        <a
          href={exportHref}
          download
          title="Download hands matching the active filters as CSV (capped at 5,000 rows)"
          className="rounded border border-line bg-surface2 px-3 py-1.5 text-xs text-ink hover:border-accent"
        >
          export csv
        </a>
      </section>

      {hands.isPending ? (
        <div className="card"><TableSkeleton rows={12} /></div>
      ) : hands.isError ? (
        <ErrorState message={(hands.error as Error)?.message} retry={() => hands.refetch()} />
      ) : allRows.length === 0 ? (
        <Empty title="No hands match these filters" hint="Loosen a filter or clear them all." />
      ) : (
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            {/* Below sm the board/reached/mirror columns hide so the two seats stay
                readable; overflow-x remains the fallback. Structure untouched. */}
            <table className="data-table max-sm:text-xs max-sm:[&_td]:px-1.5 max-sm:[&_th]:px-1.5">
              <thead>
                <tr>
                  <th className="left">time</th>
                  <th className="left">seat 1 (button)</th>
                  <th></th>
                  <th className="left">seat 2</th>
                  <th></th>
                  <th className="left hidden sm:table-cell">board</th>
                  <th>pot bb</th>
                  <th className="left hidden sm:table-cell">reached</th>
                  <th className="left hidden sm:table-cell">mirror</th>
                  <th></th>
                </tr>
              </thead>
              <tbody ref={tbodyRef}>
                {padTop > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={10} style={{ height: padTop, padding: 0, border: "none" }} />
                  </tr>
                )}
                {virtualRows.map((vr) => {
                  const h = allRows[vr.index];
                  return (
                  <tr key={h.handId} data-index={vr.index} ref={rowVirtualizer.measureElement}>
                    <td className="left font-mono text-[11px] text-ink3">{fmtTime(h.startedAt)}</td>
                    <td className="left">
                      <span className={h.winnerAgentId === h.agent1Id ? "text-ink" : "text-ink2"}>
                        {h.agent1Name}
                      </span>{" "}
                      <CardRow cards={h.agent1Hole} />
                    </td>
                    <td className={`num text-xs ${signClass(h.agent1ResultBb)}`}>
                      {fmtBb(h.agent1ResultBb, 0)}
                    </td>
                    <td className="left">
                      <span className={h.winnerAgentId === h.agent2Id ? "text-ink" : "text-ink2"}>
                        {h.agent2Name}
                      </span>{" "}
                      <CardRow cards={h.agent2Hole} />
                    </td>
                    <td className={`num text-xs ${signClass(h.agent2ResultBb)}`}>
                      {fmtBb(h.agent2ResultBb, 0)}
                    </td>
                    <td className="left hidden sm:table-cell">
                      <CardRow cards={h.boardCards} placeholders={5} />
                    </td>
                    <td className="num">
                      {h.finalPotChips === null ? "—" : chipsToBb(h.finalPotChips).toFixed(0)}
                    </td>
                    <td className="left hidden font-mono text-[11px] text-ink3 sm:table-cell">{h.streetReached}</td>
                    <td className="left hidden sm:table-cell">
                      {h.mirrorHandId ? (
                        <span className="font-mono text-[11px] text-accent" title="mirror hand ingested">
                          ⧉
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink3" title="mirror not ingested (yet)">·</span>
                      )}
                    </td>
                    <td>
                      <Link
                        href={`/hands/${h.handId}`}
                        className="font-mono text-[11px] text-ink3 hover:text-accent"
                      >
                        replay →
                      </Link>
                    </td>
                  </tr>
                  );
                })}
                {padBottom > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={10} style={{ height: padBottom, padding: 0, border: "none" }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line px-4 py-3">
            <p className="text-[11px] text-ink3">{allRows.length} hands loaded</p>
            {hands.hasNextPage ? (
              <button
                onClick={() => hands.fetchNextPage()}
                disabled={hands.isFetchingNextPage}
                className="rounded border border-line bg-surface2 px-3 py-1.5 text-xs text-ink hover:border-accent disabled:opacity-50"
              >
                {hands.isFetchingNextPage ? "loading…" : "load more"}
              </button>
            ) : (
              <p className="text-[11px] text-ink3">end of results</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export default function HandsPage() {
  return (
    <Suspense fallback={<div className="card"><TableSkeleton rows={12} /></div>}>
      <HandsBrowser />
    </Suspense>
  );
}
