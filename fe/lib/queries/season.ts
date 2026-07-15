import { COMPETITION_ID, q } from "@/lib/db";
import type { HandsPoint, SeasonResponse, SeasonSummary } from "@/lib/types";

interface SummaryRow {
  competition_id: string;
  competition_name: string | null;
  competition_status: string | null;
  total_agents: number | null;
  total_hands: number | null;
  total_blocks: number | null;
  completed_pairs: number | null;
  first_hand_at: string | null;
  last_hand_at: string | null;
  last_updated: string;
}

interface PointRow {
  bucket_ts: string;
  hands_in_bucket: number;
  hands_cumulative: number;
  active_agents: number;
}

export async function getSeason(): Promise<SeasonResponse> {
  const [summaryRows, pointRows] = await Promise.all([
    q<SummaryRow>(
      `SELECT competition_id, competition_name, competition_status,
              total_agents, total_hands, total_blocks, completed_pairs,
              first_hand_at, last_hand_at, last_updated
         FROM mart.season_summary
        WHERE competition_id = $1`,
      [COMPETITION_ID],
    ),
    q<PointRow>(
      `SELECT bucket_ts, hands_in_bucket, hands_cumulative, active_agents
         FROM mart.hands_over_time
        WHERE competition_id = $1
        ORDER BY bucket_ts
        LIMIT 5000`,
      [COMPETITION_ID],
    ),
  ]);

  const s = summaryRows[0];
  const summary: SeasonSummary | null = s
    ? {
        competitionId: s.competition_id,
        competitionName: s.competition_name,
        competitionStatus: s.competition_status,
        totalAgents: s.total_agents,
        totalHands: s.total_hands,
        totalBlocks: s.total_blocks,
        completedPairs: s.completed_pairs,
        firstHandAt: s.first_hand_at,
        lastHandAt: s.last_hand_at,
        lastUpdated: s.last_updated,
      }
    : null;

  const handsOverTime: HandsPoint[] = pointRows.map((p) => ({
    bucketTs: p.bucket_ts,
    handsInBucket: p.hands_in_bucket,
    handsCumulative: p.hands_cumulative,
    activeAgents: p.active_agents,
  }));

  return { summary, handsOverTime };
}
