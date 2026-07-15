"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HandsPoint } from "@/lib/types";

const BLUE = "#3987e5";

function fmtTick(ts: string) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function HandsSparkline({ data }: { data: HandsPoint[] }) {
  if (data.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-ink3">
        No hourly buckets yet — the sparkline fills in as the loader polls.
      </p>
    );
  }
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="handsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BLUE} stopOpacity={0.25} />
              <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="bucketTs"
            tickFormatter={fmtTick}
            tick={{ fill: "#78806f", fontSize: 10, fontFamily: "var(--font-plex)" }}
            axisLine={{ stroke: "#232a21" }}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: "#78806f", fontSize: 10, fontFamily: "var(--font-plex)" }}
            axisLine={false}
            tickLine={false}
            width={44}
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
            formatter={(value) => [String(value), "hands (cumulative)"]}
          />
          <Area
            type="monotone"
            dataKey="handsCumulative"
            stroke={BLUE}
            strokeWidth={2}
            fill="url(#handsFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
