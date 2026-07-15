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
    lastUpdated: r.last_updated,
  };
}

const COLS = `agent_id, agent_name, agent_handle, rank, trueskill_mu, trueskill_sigma,
              hands_played, blocks_played, completed_pairs, distinct_opponents,
              raw_bb_per_100, dup_adj_bb_per_100, ev_adj_bb_per_100,
              net_chips, rank_delta_7d, last_updated`;

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const rows = await q<LeaderboardDbRow>(
    `SELECT ${COLS}
       FROM mart.leaderboard
      WHERE competition_id = $1
      ORDER BY rank ASC NULLS LAST, dup_adj_bb_per_100 DESC NULLS LAST
      LIMIT 1000`,
    [COMPETITION_ID],
  );
  return rows.map(mapLeaderboardRow);
}

export async function getLeaderboardRow(agentId: string): Promise<LeaderboardRow | null> {
  const rows = await q<LeaderboardDbRow>(
    `SELECT ${COLS}
       FROM mart.leaderboard
      WHERE competition_id = $1 AND agent_id = $2`,
    [COMPETITION_ID, agentId],
  );
  return rows[0] ? mapLeaderboardRow(rows[0]) : null;
}
