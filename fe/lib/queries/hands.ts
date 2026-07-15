import { COMPETITION_ID, q } from "@/lib/db";
import type {
  HandDetailResponse,
  HandHeader,
  HandListRow,
  HandStep,
  HandsResponse,
} from "@/lib/types";

interface HandHeaderDbRow {
  hand_id: string;
  mirror_hand_id: string | null;
  block_id: string | null;
  pair_index: number | null;
  orientation: number | null;
  started_at: string | null;
  street_reached: string | null;
  agent1_id: string | null;
  agent1_name: string | null;
  agent1_hole: string[] | null;
  agent1_result_bb: number | null;
  agent1_is_button: boolean | null;
  agent2_id: string | null;
  agent2_name: string | null;
  agent2_hole: string[] | null;
  agent2_result_bb: number | null;
  board_cards: string[] | null;
  final_pot_chips: number | null;
  winner_agent_id: string | null;
}

const HEADER_COLS = `hand_id, mirror_hand_id, block_id, pair_index, orientation, started_at,
  street_reached, agent1_id, agent1_name, agent1_hole, agent1_result_bb, agent1_is_button,
  agent2_id, agent2_name, agent2_hole, agent2_result_bb,
  board_cards, final_pot_chips, winner_agent_id`;

function mapHeader(r: HandHeaderDbRow): HandHeader {
  return {
    handId: r.hand_id,
    mirrorHandId: r.mirror_hand_id,
    blockId: r.block_id,
    pairIndex: r.pair_index,
    orientation: r.orientation,
    startedAt: r.started_at,
    streetReached: r.street_reached,
    agent1Id: r.agent1_id,
    agent1Name: r.agent1_name,
    agent1Hole: r.agent1_hole,
    agent1ResultBb: r.agent1_result_bb,
    agent1IsButton: r.agent1_is_button,
    agent2Id: r.agent2_id,
    agent2Name: r.agent2_name,
    agent2Hole: r.agent2_hole,
    agent2ResultBb: r.agent2_result_bb,
    boardCards: r.board_cards,
    finalPotChips: r.final_pot_chips,
    winnerAgentId: r.winner_agent_id,
  };
}

export interface HandFilters {
  agentId: string | null;
  opponentId: string | null;
  street: string | null; // minimum street reached
  minPotBb: number | null;
  showdownOnly: boolean;
  mirrorOnly: boolean;
  limit: number;
  cursor: string | null;
}

// Opaque keyset cursor over (started_at DESC, hand_id DESC).
function encodeCursor(startedAt: string, handId: string): string {
  return Buffer.from(JSON.stringify([startedAt, handId])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") {
      return [v[0], v[1]];
    }
  } catch {
    /* malformed cursor -> treat as first page */
  }
  return null;
}

const STREET_ORD = `CASE street_reached
  WHEN 'Preflop' THEN 0 WHEN 'Flop' THEN 1 WHEN 'Turn' THEN 2
  WHEN 'River' THEN 3 WHEN 'Showdown' THEN 4 END`;

export async function listHands(f: HandFilters): Promise<HandsResponse> {
  const where: string[] = ["competition_id = $1"];
  const params: unknown[] = [COMPETITION_ID];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (f.agentId) {
    const a = p(f.agentId);
    where.push(`(agent1_id = ${a} OR agent2_id = ${a})`);
  }
  if (f.opponentId) {
    const b = p(f.opponentId);
    where.push(`(agent1_id = ${b} OR agent2_id = ${b})`);
  }
  if (f.street) {
    where.push(`${STREET_ORD} >= (CASE ${p(f.street)}::text
      WHEN 'Preflop' THEN 0 WHEN 'Flop' THEN 1 WHEN 'Turn' THEN 2
      WHEN 'River' THEN 3 WHEN 'Showdown' THEN 4 END)`);
  }
  if (f.minPotBb !== null) {
    where.push(`final_pot_chips >= ${p(f.minPotBb)}::float8 * 10`);
  }
  if (f.showdownOnly) where.push(`street_reached = 'Showdown'`);
  if (f.mirrorOnly) where.push(`mirror_hand_id IS NOT NULL`);

  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  if (cur) {
    where.push(`(started_at, hand_id) < (${p(cur[0])}::timestamptz, ${p(cur[1])})`);
  }

  const limit = f.limit;
  const rows = await q<HandHeaderDbRow>(
    `SELECT ${HEADER_COLS}
       FROM mart.hand_header
      WHERE ${where.join(" AND ")}
      ORDER BY started_at DESC, hand_id DESC
      LIMIT ${p(limit + 1)}`,
    params,
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last?.started_at
      ? encodeCursor(last.started_at, last.hand_id)
      : null;

  const hands: HandListRow[] = page.map(mapHeader);
  return { hands, nextCursor };
}

interface StepDbRow {
  sequence: number;
  street: string | null;
  actor_agent_id: string | null;
  actor_name: string | null;
  is_button: boolean | null;
  action: string | null;
  size_bb: number | null;
  size_pot_fraction: number | null;
  pot_before: number | null;
  pot_after: number | null;
  stack_before: number | null;
  board_so_far: string[] | null;
  equity_at_decision: number | null;
  reasoning_text: string | null;
}

function mapStep(r: StepDbRow): HandStep {
  return {
    sequence: r.sequence,
    street: r.street,
    actorAgentId: r.actor_agent_id,
    actorName: r.actor_name,
    isButton: r.is_button,
    action: r.action,
    sizeBb: r.size_bb,
    sizePotFraction: r.size_pot_fraction,
    potBefore: r.pot_before,
    potAfter: r.pot_after,
    stackBefore: r.stack_before,
    boardSoFar: r.board_so_far,
    equityAtDecision: r.equity_at_decision,
    reasoningText: r.reasoning_text,
  };
}

async function getHeader(handId: string): Promise<HandHeader | null> {
  const rows = await q<HandHeaderDbRow>(
    `SELECT ${HEADER_COLS} FROM mart.hand_header
      WHERE hand_id = $1 AND competition_id = $2`,
    [handId, COMPETITION_ID],
  );
  return rows[0] ? mapHeader(rows[0]) : null;
}

async function getSteps(handId: string): Promise<HandStep[]> {
  const rows = await q<StepDbRow>(
    `SELECT sequence, street, actor_agent_id, actor_name, is_button, action,
            size_bb, size_pot_fraction, pot_before, pot_after, stack_before,
            board_so_far, equity_at_decision, reasoning_text
       FROM mart.hand_step
      WHERE hand_id = $1
      ORDER BY sequence
      LIMIT 500`,
    [handId],
  );
  return rows.map(mapStep);
}

export async function getHandDetail(handId: string): Promise<HandDetailResponse | null> {
  const header = await getHeader(handId);
  if (!header) return null;

  const [steps, mirrorHeader, mirrorSteps] = await Promise.all([
    getSteps(handId),
    header.mirrorHandId ? getHeader(header.mirrorHandId) : Promise.resolve(null),
    header.mirrorHandId ? getSteps(header.mirrorHandId) : Promise.resolve([]),
  ]);

  return {
    header,
    steps,
    mirror: mirrorHeader ? { header: mirrorHeader, steps: mirrorSteps } : null,
  };
}
