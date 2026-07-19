import { COMPETITION_ID, q } from "@/lib/db";

// Response contract for GET /api/agents/[agentId]/performance-history.
// Co-located with the query (lib/types is owned by another feature).
// One row per UTC day of mart.agent_daily_performance: cumulative raw /
// duplicate-adjusted / EV-adjusted bb/100 — each agent's final day reconciles
// with the leaderboard. dupAdjBb100Cum is NULL until the first completed
// mirror pair (same NULL handling as mart.leaderboard).
export interface AgentPerformancePoint {
  day: string; // "YYYY-MM-DD" (UTC day grain)
  handsCum: number;
  rawBb100Cum: number | null;
  dupAdjBb100Cum: number | null;
  evAdjBb100Cum: number | null;
}

export interface AgentPerformanceHistoryResponse {
  agentId: string;
  points: AgentPerformancePoint[];
}

interface AgentPerformanceDbRow {
  day: string;
  hands_cum: number;
  raw_bb100_cum: number | null;
  dup_adj_bb100_cum: number | null;
  ev_adj_bb100_cum: number | null;
}

// 42P01 = undefined_table. mart.agent_daily_performance is created + filled by
// the transform (arena_transform.py). Until the pipeline has run once against
// this schema, treat "table not there yet" as simply "no history" instead of a
// 500 — so the Trends card degrades to its empty state (same stance as
// getRankHistory).
function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "42P01"
  );
}

export async function getAgentPerformanceHistory(
  agentId: string,
): Promise<AgentPerformancePoint[]> {
  try {
    const rows = await q<AgentPerformanceDbRow>(
      `SELECT day::text AS day, hands_cum,
              raw_bb100_cum, dup_adj_bb100_cum, ev_adj_bb100_cum
         FROM mart.agent_daily_performance
        WHERE competition_id = $1 AND agent_id = $2
        ORDER BY day ASC
        LIMIT 400`,
      [COMPETITION_ID, agentId],
    );
    return rows.map((r) => ({
      day: r.day,
      handsCum: r.hands_cum,
      rawBb100Cum: r.raw_bb100_cum,
      dupAdjBb100Cum: r.dup_adj_bb100_cum,
      evAdjBb100Cum: r.ev_adj_bb100_cum,
    }));
  } catch (err) {
    if (isUndefinedTable(err)) return [];
    throw err;
  }
}
