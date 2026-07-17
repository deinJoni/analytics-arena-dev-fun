import { COMPETITION_ID, q } from "@/lib/db";
import type { SizingSplit } from "@/lib/types";

// Bet-size distribution per (street, position) off mart.hand_step — only
// bet/raise rows carry size_pot_fraction. Bucket edges match the transform's
// mart.agent_stats.sizing_histogram exactly (verified: <0.33, <0.66, <=1.0, else 100+).
interface SizingDbRow {
  street: string;
  position: "IP" | "OOP";
  bucket: string;
  n: number;
  avg_frac: number;
}

export async function getAgentSizing(agentId: string): Promise<SizingSplit[]> {
  const rows = await q<SizingDbRow>(
    `SELECT s.street,
            CASE WHEN s.is_button THEN 'IP' ELSE 'OOP' END AS position,
            CASE WHEN s.size_pot_fraction < 0.33 THEN '0-33'
                 WHEN s.size_pot_fraction < 0.66 THEN '33-66'
                 WHEN s.size_pot_fraction <= 1.0 THEN '66-100'
                 ELSE '100+' END AS bucket,
            count(*)::int AS n,
            avg(s.size_pot_fraction)::float8 AS avg_frac
       FROM mart.hand_step s
       JOIN mart.hand_header h USING (hand_id)
      WHERE h.competition_id = $1
        AND s.actor_agent_id = $2
        AND s.size_pot_fraction IS NOT NULL
        AND s.action IN ('bet', 'raise')
      GROUP BY 1, 2, 3`,
    [COMPETITION_ID, agentId],
  );

  const byKey = new Map<string, SizingSplit & { fracSum: number }>();
  for (const r of rows) {
    const key = `${r.street}|${r.position}`;
    const split =
      byKey.get(key) ??
      byKey
        .set(key, {
          street: r.street,
          position: r.position,
          total: 0,
          avgPotFraction: null,
          buckets: {},
          fracSum: 0,
        })
        .get(key)!;
    split.buckets[r.bucket] = r.n;
    split.total += r.n;
    split.fracSum += r.avg_frac * r.n;
  }

  return [...byKey.values()].map(({ fracSum, ...s }) => ({
    ...s,
    avgPotFraction: s.total > 0 ? fracSum / s.total : null,
  }));
}
