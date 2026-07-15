import { COMPETITION_ID, q } from "@/lib/db";
import type { MatchupCell, MatchupDetail, SpotDelta } from "@/lib/types";

interface MatchupDbRow {
  agent_a_id: string;
  a_name: string | null;
  a_rank: number | null;
  agent_b_id: string;
  b_name: string | null;
  b_rank: number | null;
  blocks: number | null;
  completed_pairs: number | null;
  hands: number | null;
  a_raw_bb_per_100: number | null;
  a_dup_adj_bb_per_100: number | null;
  a_ev_adj_bb_per_100: number | null;
  a_win_rate: number | null;
  spot_deltas?: SpotDelta[] | null;
  last_updated?: string;
}

const CELL_COLS = `m.agent_a_id, la.agent_name AS a_name, la.rank AS a_rank,
  m.agent_b_id, lb.agent_name AS b_name, lb.rank AS b_rank,
  m.blocks, m.completed_pairs, m.hands,
  m.a_raw_bb_per_100, m.a_dup_adj_bb_per_100, m.a_ev_adj_bb_per_100, m.a_win_rate`;

const CELL_JOINS = `FROM mart.matchups m
  LEFT JOIN mart.leaderboard la
    ON la.competition_id = m.competition_id AND la.agent_id = m.agent_a_id
  LEFT JOIN mart.leaderboard lb
    ON lb.competition_id = m.competition_id AND lb.agent_id = m.agent_b_id`;

function mapCell(r: MatchupDbRow): MatchupCell {
  return {
    agentAId: r.agent_a_id,
    agentAName: r.a_name,
    agentARank: r.a_rank,
    agentBId: r.agent_b_id,
    agentBName: r.b_name,
    agentBRank: r.b_rank,
    blocks: r.blocks,
    completedPairs: r.completed_pairs,
    hands: r.hands,
    aRawBbPer100: r.a_raw_bb_per_100,
    aDupAdjBbPer100: r.a_dup_adj_bb_per_100,
    aEvAdjBbPer100: r.a_ev_adj_bb_per_100,
    aWinRate: r.a_win_rate,
  };
}

export async function getMatchups(): Promise<MatchupCell[]> {
  const rows = await q<MatchupDbRow>(
    `SELECT ${CELL_COLS}
       ${CELL_JOINS}
      WHERE m.competition_id = $1
      ORDER BY la.rank ASC NULLS LAST, lb.rank ASC NULLS LAST
      LIMIT 20000`,
    [COMPETITION_ID],
  );
  return rows.map(mapCell);
}

export async function getMatchupDetail(aId: string, bId: string): Promise<MatchupDetail | null> {
  const rows = await q<MatchupDbRow>(
    `SELECT ${CELL_COLS}, m.spot_deltas, m.last_updated
       ${CELL_JOINS}
      WHERE m.competition_id = $1 AND m.agent_a_id = $2 AND m.agent_b_id = $3`,
    [COMPETITION_ID, aId, bId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...mapCell(r),
    spotDeltas: r.spot_deltas ?? null,
    lastUpdated: r.last_updated!,
  };
}
