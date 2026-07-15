import { COMPETITION_ID, q } from "@/lib/db";
import type { AgentStatsSplit } from "@/lib/types";

interface StatsDbRow {
  position: "ALL" | "IP" | "OOP";
  sample_n: number;
  vpip_pct: number | null;
  pfr_pct: number | null;
  three_bet_pct: number | null;
  fold_to_three_bet_pct: number | null;
  cbet_flop_pct: number | null;
  fold_to_cbet_flop_pct: number | null;
  cbet_turn_pct: number | null;
  cbet_river_pct: number | null;
  check_raise_pct: number | null;
  wtsd_pct: number | null;
  wsd_pct: number | null;
  wwsf_pct: number | null;
  aggression_factor: number | null;
  aggression_freq_pct: number | null;
  avg_bet_pot_fraction: number | null;
  sizing_histogram: Record<string, number> | null;
  bb_per_100: number | null;
  opportunities: Record<string, number> | null;
}

export async function getAgentStats(agentId: string): Promise<AgentStatsSplit[]> {
  const rows = await q<StatsDbRow>(
    `SELECT position, sample_n, vpip_pct, pfr_pct, three_bet_pct, fold_to_three_bet_pct,
            cbet_flop_pct, fold_to_cbet_flop_pct, cbet_turn_pct, cbet_river_pct,
            check_raise_pct, wtsd_pct, wsd_pct, wwsf_pct,
            aggression_factor, aggression_freq_pct, avg_bet_pot_fraction,
            sizing_histogram, bb_per_100, opportunities
       FROM mart.agent_stats
      WHERE competition_id = $1 AND agent_id = $2
      ORDER BY CASE position WHEN 'ALL' THEN 0 WHEN 'IP' THEN 1 ELSE 2 END`,
    [COMPETITION_ID, agentId],
  );
  return rows.map((r) => ({
    position: r.position,
    sampleN: r.sample_n,
    vpipPct: r.vpip_pct,
    pfrPct: r.pfr_pct,
    threeBetPct: r.three_bet_pct,
    foldToThreeBetPct: r.fold_to_three_bet_pct,
    cbetFlopPct: r.cbet_flop_pct,
    foldToCbetFlopPct: r.fold_to_cbet_flop_pct,
    cbetTurnPct: r.cbet_turn_pct,
    cbetRiverPct: r.cbet_river_pct,
    checkRaisePct: r.check_raise_pct,
    wtsdPct: r.wtsd_pct,
    wsdPct: r.wsd_pct,
    wwsfPct: r.wwsf_pct,
    aggressionFactor: r.aggression_factor,
    aggressionFreqPct: r.aggression_freq_pct,
    avgBetPotFraction: r.avg_bet_pot_fraction,
    sizingHistogram: r.sizing_histogram,
    bbPer100: r.bb_per_100,
    opportunities: r.opportunities,
  }));
}
