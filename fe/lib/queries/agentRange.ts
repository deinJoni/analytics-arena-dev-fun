import { COMPETITION_ID, q } from "@/lib/db";
import type { RangeCombo, RangeNode, RangeNodeAction } from "@/lib/types";

// Full preflop strategy over the 13x13 grid in one shape: for every combo,
// the agent's action mix at each decision node. A node is (position, raises
// seen so far); heads-up the button (SB) is IP and acts first preflop, so:
//   ip_first     button, no raise yet        -> open / limp / fold
//   oop_vs_open  big blind facing an open    -> 3-bet / call / fold
//   oop_vs_limp  big blind after a limp      -> iso-raise / check
//   ip_vs_3bet   button facing a 3-bet       -> 4-bet / call / fold
// Denominators are per-node opportunities, so shares are honest by construction.

const MINE_AND_PARSED = `
  mine AS (
    SELECT h.hand_id,
           CASE WHEN h.agent1_id = $2 THEN h.agent1_hole ELSE h.agent2_hole END AS hole,
           CASE WHEN h.agent1_id = $2 THEN h.agent1_result_bb ELSE h.agent2_result_bb END AS result_bb,
           CASE WHEN h.agent1_id = $2 THEN h.agent1_is_button ELSE NOT h.agent1_is_button END AS is_button
      FROM mart.hand_header h
     WHERE h.competition_id = $1 AND (h.agent1_id = $2 OR h.agent2_id = $2)
  ),
  parsed AS (
    SELECT hand_id, result_bb, is_button,
           CASE WHEN strpos('AKQJT98765432', left(hole[1], length(hole[1]) - 1))
                  <= strpos('AKQJT98765432', left(hole[2], length(hole[2]) - 1))
                THEN left(hole[1], length(hole[1]) - 1) || left(hole[2], length(hole[2]) - 1)
                ELSE left(hole[2], length(hole[2]) - 1) || left(hole[1], length(hole[1]) - 1) END
           || CASE WHEN left(hole[1], length(hole[1]) - 1) = left(hole[2], length(hole[2]) - 1) THEN ''
                   WHEN right(hole[1], 1) = right(hole[2], 1) THEN 's' ELSE 'o' END AS hand
      FROM mine
     WHERE hole IS NOT NULL AND array_length(hole, 1) = 2
  )`;

interface DealtDbRow {
  hand: string;
  dealt_n: number;
  bb_per_100: number | null;
  win_rate: number | null;
}

interface ActionDbRow {
  hand: string;
  node: RangeNode;
  action: string;
  n: number;
  bb_per_100: number | null;
  win_rate: number | null;
}

export async function getAgentRangeStrategy(agentId: string): Promise<RangeCombo[]> {
  const [dealt, actions] = await Promise.all([
    q<DealtDbRow>(
      `WITH ${MINE_AND_PARSED}
       SELECT hand,
              count(*)::int AS dealt_n,
              (avg(result_bb) * 100)::float8 AS bb_per_100,
              avg((result_bb > 0)::int)::float8 AS win_rate
         FROM parsed
        GROUP BY 1`,
      [COMPETITION_ID, agentId],
    ),
    q<ActionDbRow>(
      `WITH ${MINE_AND_PARSED},
       pf AS (
         -- Filter to the target agent's hands BEFORE the window runs. The
         -- window is PARTITION BY hand_id, so dropping whole partitions cannot
         -- change raises_before for retained hands. Keep both actors' rows
         -- (opponent raises still count in raises_before); actor filter stays
         -- after the join below. The PK (hand_id, sequence) serves the IN probe.
         SELECT hand_id, sequence, action, actor_agent_id,
                count(*) FILTER (WHERE action = 'raise')
                  OVER (PARTITION BY hand_id ORDER BY sequence
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS raises_before
           FROM mart.hand_step
          WHERE street = 'Preflop'
            AND hand_id IN (SELECT hand_id FROM mine)
       ),
       acts AS (
         SELECT p.hand, p.result_bb, f.action,
                CASE WHEN p.is_button AND f.raises_before = 0 THEN 'ip_first'
                     WHEN NOT p.is_button AND f.raises_before = 1 THEN 'oop_vs_open'
                     WHEN NOT p.is_button AND f.raises_before = 0 THEN 'oop_vs_limp'
                     WHEN p.is_button AND f.raises_before = 2 THEN 'ip_vs_3bet'
                END AS node
           FROM pf f
           JOIN parsed p USING (hand_id)
          WHERE f.actor_agent_id = $2
       )
       SELECT hand, node, action,
              count(*)::int AS n,
              (avg(result_bb) * 100)::float8 AS bb_per_100,
              avg((result_bb > 0)::int)::float8 AS win_rate
         FROM acts
        WHERE node IS NOT NULL
        GROUP BY 1, 2, 3`,
      [COMPETITION_ID, agentId],
    ),
  ]);

  const byHand = new Map<string, RangeCombo>(
    dealt.map((d) => [
      d.hand,
      {
        hand: d.hand,
        dealtN: d.dealt_n,
        bbPer100: d.bb_per_100,
        winRate: d.win_rate,
        nodes: {},
      },
    ]),
  );

  for (const a of actions) {
    const combo = byHand.get(a.hand);
    if (!combo) continue;
    const entry: RangeNodeAction = {
      action: a.action,
      n: a.n,
      bbPer100: a.bb_per_100,
      winRate: a.win_rate,
    };
    (combo.nodes[a.node] ??= []).push(entry);
  }

  return [...byHand.values()];
}
