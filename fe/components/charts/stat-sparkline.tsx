"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// One point of a generic time series: t = ISO timestamp or "YYYY-MM-DD" day,
// v = metric value (null = honest gap, e.g. dup-adj before the first
// completed mirror pair — never charted as zero).
export interface SparkPoint {
  t: string | number;
  v: number | null;
}

const BRASS = "#cfa04d"; // --accent

function isDateOnly(t: string | number): boolean {
  return typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t);
}

// Date-only buckets are pinned to UTC so the label never shifts a day with the
// viewer's timezone; full timestamps render in local time (matches the other
// charts).
function fmtTick(t: string | number): string {
  const d = new Date(t);
  if (isDateOnly(t)) {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    hour12: false,
  });
}

// Compact area sparkline for one metric over time (score, rank, bb/100, …).
// Style matches hands-sparkline / rank-trajectory: minimal axes, ink3 ticks,
// dashed cursor, gradient fill. Nulls are gaps, not zeros.
export function StatSparkline({
  data,
  label,
  formatValue = (v) => String(v),
  color = BRASS,
}: {
  data: SparkPoint[];
  label: string;
  formatValue?: (v: number) => string;
  color?: string;
}) {
  // Multiple sparklines share a page: the gradient id must be unique per
  // instance (useId can contain ":", which url(#…) references dislike).
  const gradientId = `sparkFill${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  if (data.every((p) => p.v === null)) {
    return <p className="py-4 text-center text-xs text-ink3">—</p>;
  }

  return (
    <div className="h-32 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            tickFormatter={fmtTick}
            tick={{ fill: "var(--ink3)", fontSize: 10, fontFamily: "var(--font-plex)" }}
            axisLine={{ stroke: "var(--line)" }}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => formatValue(v)}
            tick={{ fill: "var(--ink3)", fontSize: 10, fontFamily: "var(--font-plex)" }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            cursor={{ stroke: "var(--ink3)", strokeDasharray: "3 3" }}
            contentStyle={{
              background: "var(--surface-2)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-plex)",
            }}
            labelFormatter={(t) => fmtTick(typeof t === "number" ? t : String(t))}
            formatter={(value) => [
              typeof value === "number" ? formatValue(value) : "—",
              label,
            ]}
          />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
