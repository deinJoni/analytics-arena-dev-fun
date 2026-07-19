import { COMPETITION_ID, q } from "@/lib/db";
import type { LeaderboardRow } from "@/lib/types";

export interface LeaderboardDbRow {
  agent_id: string;
  agent_name: string | null;
  agent_handle: string | null;
  rank: number | null;
  trueskill_mu: number | null;
  trueskill_sigma: number | null;
  hands_played: number | null;
  blocks_played: number | null;
  completed_pairs: number | null;
  distinct_opponents: number | null;
  raw_bb_per_100: number | null;
  dup_adj_bb_per_100: number | null;
  ev_adj_bb_per_100: number | null;
  net_chips: number | null;
  rank_delta_7d: number | null;
  mu_delta_7d: number | null;
  last_updated: string;
}

export function mapLeaderboardRow(r: LeaderboardDbRow): LeaderboardRow {
  return {
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentHandle: r.agent_handle,
    rank: r.rank,
    trueskillMu: r.trueskill_mu,
    trueskillSigma: r.trueskill_sigma,
    handsPlayed: r.hands_played,
    blocksPlayed: r.blocks_played,
    completedPairs: r.completed_pairs,
    distinctOpponents: r.distinct_opponents,
    rawBbPer100: r.raw_bb_per_100,
    dupAdjBbPer100: r.dup_adj_bb_per_100,
    evAdjBbPer100: r.ev_adj_bb_per_100,
    netChips: r.net_chips,
    rankDelta7d: r.rank_delta_7d,
    muDelta7d: r.mu_delta_7d,
    // Filled in by the caller from getRankDeltas24h() (separate query —
    // mart.rank_history may not exist yet, so it must not sink this one).
    rankDelta24h: null,
    lastUpdated: r.last_updated,
  };
}

const COLS = `agent_id, agent_name, agent_handle, rank, trueskill_mu, trueskill_sigma,
              hands_played, blocks_played, completed_pairs, distinct_opponents,
              raw_bb_per_100, dup_adj_bb_per_100, ev_adj_bb_per_100,
              net_chips, rank_delta_7d, mu_delta_7d, last_updated`;

// 42P01 = undefined_table. mart.rank_history is created + filled by the
// transform (arena_transform.py); until it has run once against this schema,
// treat "table not there yet" as "no 24h deltas" (nulls) instead of a 500 —
// same degradation as fe/lib/queries/rankHistory.ts.
function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "42P01"
  );
}

interface RankDeltaDbRow {
  agent_id: string;
  rank_delta_24h: number | null;
}

// 24h ladder movement per agent: position at the latest rank_history snapshot
// taken at least 24h ago minus the current position. Positive = climbed, same
// sign convention as mart.leaderboard.rank_delta_7d (lb7.rank - lb.rank in the
// transform). mart.rank_history.rank and mart.leaderboard.rank are the same
// ordering (row_number() over total_score DESC), so the subtraction is
// apples-to-apples. NULL when the agent has no snapshot that old yet.
async function getRankDeltas24h(agentId?: string): Promise<Map<string, number | null>> {
  try {
    const rows = await q<RankDeltaDbRow>(
      `SELECT lb.agent_id, rh.rank - lb.rank AS rank_delta_24h
         FROM mart.leaderboard lb
         LEFT JOIN LATERAL (
           SELECT h.rank
             FROM mart.rank_history h
            WHERE h.competition_id = lb.competition_id
              AND h.agent_id = lb.agent_id
              AND h.captured_at <= now() - interval '24 hours'
            ORDER BY h.captured_at DESC
            LIMIT 1
         ) rh ON true
        WHERE lb.competition_id = $1
          ${agentId ? "AND lb.agent_id = $2" : ""}`,
      agentId ? [COMPETITION_ID, agentId] : [COMPETITION_ID],
    );
    return new Map(rows.map((r) => [r.agent_id, r.rank_delta_24h]));
  } catch (err) {
    if (isUndefinedTable(err)) return new Map();
    throw err;
  }
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const rows = await q<LeaderboardDbRow>(
    `SELECT ${COLS}
       FROM mart.leaderboard
      WHERE competition_id = $1
      ORDER BY trueskill_mu DESC NULLS LAST, dup_adj_bb_per_100 DESC NULLS LAST
      LIMIT 1000`,
    [COMPETITION_ID],
  );
  const deltas = await getRankDeltas24h();
  return rows.map((r) => ({
    ...mapLeaderboardRow(r),
    rankDelta24h: deltas.get(r.agent_id) ?? null,
  }));
}

export async function getLeaderboardRow(agentId: string): Promise<LeaderboardRow | null> {
  const rows = await q<LeaderboardDbRow>(
    `SELECT ${COLS}
       FROM mart.leaderboard
      WHERE competition_id = $1 AND agent_id = $2`,
    [COMPETITION_ID, agentId],
  );
  if (!rows[0]) return null;
  const deltas = await getRankDeltas24h(agentId);
  return { ...mapLeaderboardRow(rows[0]), rankDelta24h: deltas.get(agentId) ?? null };
}
