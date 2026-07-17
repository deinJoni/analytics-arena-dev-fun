// Shared response contracts for the /api/* endpoints (PRD §6).
// snake_case DB columns are mapped to these camelCase shapes in lib/queries.

export interface SeasonSummary {
  competitionId: string;
  competitionName: string | null;
  competitionStatus: string | null;
  totalAgents: number | null;
  totalHands: number | null;
  totalBlocks: number | null;
  completedPairs: number | null;
  firstHandAt: string | null;
  lastHandAt: string | null;
  lastUpdated: string;
}

export interface HandsPoint {
  bucketTs: string;
  handsInBucket: number;
  handsCumulative: number;
  activeAgents: number;
}

export interface SeasonResponse {
  summary: SeasonSummary | null;
  handsOverTime: HandsPoint[];
}

export interface LeaderboardRow {
  agentId: string;
  agentName: string | null;
  agentHandle: string | null;
  rank: number | null;
  trueskillMu: number | null;
  trueskillSigma: number | null;
  handsPlayed: number | null;
  blocksPlayed: number | null;
  completedPairs: number | null;
  distinctOpponents: number | null;
  rawBbPer100: number | null;
  dupAdjBbPer100: number | null;
  evAdjBbPer100: number | null;
  netChips: number | null;
  rankDelta7d: number | null;
  lastUpdated: string;
}

// One captured point of an agent's ladder position over time (mart.rank_history).
// `rank` is the arena.dev.fun ordering (position by totalScore DESC) at that snapshot.
export interface RankHistoryPoint {
  capturedAt: string;
  rank: number | null;
  totalScore: number | null;
  fieldSize: number | null;
}

export interface RankHistoryResponse {
  agentId: string;
  points: RankHistoryPoint[];
}

// One ALL / IP / OOP row of mart.agent_stats.
export interface AgentStatsSplit {
  position: "ALL" | "IP" | "OOP";
  sampleN: number;
  vpipPct: number | null;
  pfrPct: number | null;
  threeBetPct: number | null;
  foldToThreeBetPct: number | null;
  cbetFlopPct: number | null;
  foldToCbetFlopPct: number | null;
  cbetTurnPct: number | null;
  cbetRiverPct: number | null;
  checkRaisePct: number | null;
  wtsdPct: number | null;
  wsdPct: number | null;
  wwsfPct: number | null;
  aggressionFactor: number | null;
  aggressionFreqPct: number | null;
  avgBetPotFraction: number | null;
  sizingHistogram: Record<string, number> | null;
  bbPer100: number | null;
  // per-stat denominators, for honest thin-sample greying
  opportunities: Record<string, number> | null;
}

export interface AgentStatsResponse {
  header: LeaderboardRow;
  splits: AgentStatsSplit[];
}

export interface LeakRow {
  position: "IP" | "OOP";
  street: string;
  boardTexture: string | null;
  line: string;
  sampleN: number;
  bbPer100Spot: number | null;
  evBbPer100Spot: number | null;
  mirrorN: number;
  mirrorDeltaBb: number | null;
}

// Preflop strategy per starting combo ("AKs" / "T9o" / "QQ"), broken down by
// decision node. Heads-up nodes: the button's first decision, the big blind
// facing an open / a limp, and the button facing a 3-bet.
export type RangeNode = "ip_first" | "oop_vs_open" | "oop_vs_limp" | "ip_vs_3bet";

export interface RangeNodeAction {
  action: string; // raise | call | fold | check
  n: number;
  bbPer100: number | null; // whole-hand result over hands where this action was taken
  winRate: number | null;
}

export interface RangeCombo {
  hand: string;
  dealtN: number;
  bbPer100: number | null; // whole-hand result over all dealt hands with this combo
  winRate: number | null;
  nodes: Partial<Record<RangeNode, RangeNodeAction[]>>;
}

// Bet-sizing distribution for one (street, position) split, %-of-pot buckets.
export interface SizingSplit {
  street: string; // Preflop | Flop | Turn | River
  position: "IP" | "OOP";
  total: number;
  avgPotFraction: number | null;
  buckets: Record<string, number>; // {"0-33": n, "33-66": n, "66-100": n, "100+": n}
}

export interface HandListRow {
  handId: string;
  mirrorHandId: string | null;
  blockId: string | null;
  startedAt: string | null;
  streetReached: string | null;
  agent1Id: string | null;
  agent1Name: string | null;
  agent1Hole: string[] | null;
  agent1ResultBb: number | null;
  agent1IsButton: boolean | null;
  agent2Id: string | null;
  agent2Name: string | null;
  agent2Hole: string[] | null;
  agent2ResultBb: number | null;
  boardCards: string[] | null;
  finalPotChips: number | null;
  winnerAgentId: string | null;
}

export interface HandsResponse {
  hands: HandListRow[];
  nextCursor: string | null;
}

export interface HandHeader extends HandListRow {
  pairIndex: number | null;
  orientation: number | null;
}

export interface HandStep {
  sequence: number;
  street: string | null;
  actorAgentId: string | null;
  actorName: string | null;
  isButton: boolean | null;
  action: string | null;
  sizeBb: number | null;
  sizePotFraction: number | null;
  potBefore: number | null;
  potAfter: number | null;
  stackBefore: number | null;
  boardSoFar: string[] | null;
  equityAtDecision: number | null;
  reasoningText: string | null;
}

export interface HandDetailResponse {
  header: HandHeader;
  steps: HandStep[];
  mirror: { header: HandHeader; steps: HandStep[] } | null;
}

export interface MatchupCell {
  agentAId: string;
  agentAName: string | null;
  agentARank: number | null;
  agentBId: string;
  agentBName: string | null;
  agentBRank: number | null;
  blocks: number | null;
  completedPairs: number | null;
  hands: number | null;
  aRawBbPer100: number | null;
  aDupAdjBbPer100: number | null;
  aEvAdjBbPer100: number | null;
  aWinRate: number | null;
}

export interface SpotDelta {
  position: "IP" | "OOP";
  street: string;
  board_texture: string;
  line: string;
  mirror_n: number;
  mirror_delta_bb: number;
}

export interface MatchupDetail extends MatchupCell {
  spotDeltas: SpotDelta[] | null;
  lastUpdated: string;
}
