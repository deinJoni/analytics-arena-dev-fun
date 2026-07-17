"use client";

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useApi } from "@/lib/api";
import { fmt1 } from "@/lib/format";
import type { RankHistoryResponse } from "@/lib/types";

const BRASS = "#cfa04d";

function fmtTick(ts: string) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    hour12: false,
  });
}

// Ladder-position trajectory for one agent (mart.rank_history). Y axis is
// reversed so #1 sits at the top — climbing reads as "going up".
export function RankTrajectory({ agentId }: { agentId: string }) {
  const { data, isPending, isError } = useApi<RankHistoryResponse>(
    `/api/agents/${agentId}/rank-history`,
  );

  if (isPending) return <div className="skeleton h-28 w-full" />;
  if (isError)
    return (
      <p className="py-4 text-center text-xs text-neg/80">
        Couldn’t load rank history.
      </p>
    );

  const points = data?.points ?? [];
  if (points.length < 2) {
    return (
      <p className="py-4 text-center text-xs text-ink3">
        Not enough history yet — ladder positions accrue hourly as the loader
        polls, so this fills in over the coming days.
      </p>
    );
  }

  const first = points[0];
  const last = points[points.length - 1];
  const moved = (first.rank ?? 0) - (last.rank ?? 0); // positive = climbed
  const ranks = points.map((p) => p.rank ?? 0).filter((r) => r > 0);
  const top = Math.min(...ranks);
  const bottom = Math.max(...ranks);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="eyebrow">rank history</span>
        <span className="num text-ink">
          #{first.rank} → #{last.rank}
        </span>
        <span
          className={`num ${moved > 0 ? "text-pos" : moved < 0 ? "text-neg" : "text-ink3"}`}
          title="change in ladder position over the recorded window"
        >
          {moved > 0 ? `▲ ${moved}` : moved < 0 ? `▼ ${-moved}` : "no change"}
        </span>
        <span className="num text-ink3">
          score {fmt1(first.totalScore)} → {fmt1(last.totalScore)}
        </span>
        <span className="text-ink3">
          {points.length} snapshots · since {fmtTick(first.capturedAt)}
        </span>
      </div>
      <div className="h-28 w-full">
        <ResponsiveContainer>
          <LineChart
            data={points}
            margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
          >
            <XAxis
              dataKey="capturedAt"
              tickFormatter={fmtTick}
              tick={{ fill: "#78806f", fontSize: 10, fontFamily: "var(--font-plex)" }}
              axisLine={{ stroke: "#232a21" }}
              tickLine={false}
              minTickGap={50}
            />
            <YAxis
              reversed
              domain={[Math.max(1, top - 1), bottom + 1]}
              allowDecimals={false}
              tickFormatter={(v) => `#${v}`}
              tick={{ fill: "#78806f", fontSize: 10, fontFamily: "var(--font-plex)" }}
              axisLine={false}
              tickLine={false}
              width={38}
            />
            <Tooltip
              cursor={{ stroke: "#78806f", strokeDasharray: "3 3" }}
              contentStyle={{
                background: "#171c15",
                border: "1px solid #232a21",
                borderRadius: 6,
                fontSize: 12,
                fontFamily: "var(--font-plex)",
              }}
              labelFormatter={(ts) => fmtTick(String(ts))}
              formatter={(value) => [`#${value}`, "ladder rank"]}
            />
            <Line
              type="monotone"
              dataKey="rank"
              stroke={BRASS}
              strokeWidth={2}
              dot={{ r: 2, strokeWidth: 0, fill: BRASS }}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
