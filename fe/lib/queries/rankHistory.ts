import { COMPETITION_ID, q } from "@/lib/db";
import type { RankHistoryPoint } from "@/lib/types";

interface RankHistoryDbRow {
  captured_at: string;
  rank: number | null;
  total_score: number | null;
  field_size: number | null;
}

// 42P01 = undefined_table. mart.rank_history is created + filled by the
// transform (arena_transform.py). Until the pipeline has run once against this
// schema, treat "table not there yet" as simply "no history" instead of a 500 —
// so the drill-down degrades to its empty state rather than erroring.
function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "42P01"
  );
}

export async function getRankHistory(agentId: string): Promise<RankHistoryPoint[]> {
  try {
    const rows = await q<RankHistoryDbRow>(
      `SELECT captured_at, rank, total_score, field_size
         FROM mart.rank_history
        WHERE competition_id = $1 AND agent_id = $2
        ORDER BY captured_at ASC
        LIMIT 2000`,
      [COMPETITION_ID, agentId],
    );
    return rows.map((r) => ({
      capturedAt: r.captured_at,
      rank: r.rank,
      totalScore: r.total_score,
      fieldSize: r.field_size,
    }));
  } catch (err) {
    if (isUndefinedTable(err)) return [];
    throw err;
  }
}
