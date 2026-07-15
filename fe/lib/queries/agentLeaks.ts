import { COMPETITION_ID, q } from "@/lib/db";
import type { LeakRow } from "@/lib/types";

interface LeakDbRow {
  position: "IP" | "OOP";
  street: string;
  board_texture: string | null;
  line: string;
  sample_n: number;
  bb_per_100_spot: number | null;
  ev_bb_per_100_spot: number | null;
  mirror_n: number;
  mirror_delta_bb: number | null;
}

export interface LeakFilters {
  position: "IP" | "OOP" | null;
  street: string | null;
  texture: string | null;
  minSampleN: number;
}

export async function getAgentLeaks(agentId: string, f: LeakFilters): Promise<LeakRow[]> {
  const rows = await q<LeakDbRow>(
    `SELECT position, street, board_texture, line, sample_n,
            bb_per_100_spot, ev_bb_per_100_spot, mirror_n, mirror_delta_bb
       FROM mart.agent_leaks
      WHERE competition_id = $1 AND agent_id = $2
        AND ($3::text IS NULL OR position = $3)
        AND ($4::text IS NULL OR street = $4)
        AND ($5::text IS NULL OR board_texture = $5)
        AND sample_n >= $6
      ORDER BY mirror_delta_bb ASC NULLS LAST, sample_n DESC
      LIMIT 1000`,
    [COMPETITION_ID, agentId, f.position, f.street, f.texture, f.minSampleN],
  );
  return rows.map((r) => ({
    position: r.position,
    street: r.street,
    boardTexture: r.board_texture,
    line: r.line,
    sampleN: r.sample_n,
    bbPer100Spot: r.bb_per_100_spot,
    evBbPer100Spot: r.ev_bb_per_100_spot,
    mirrorN: r.mirror_n,
    mirrorDeltaBb: r.mirror_delta_bb,
  }));
}
