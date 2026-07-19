import { type NextRequest, NextResponse } from "next/server";
import { badRequest, guarded } from "@/lib/api-helpers";
import { chipsToBb } from "@/lib/format";
import { listHands } from "@/lib/queries/hands";
import type { HandListRow } from "@/lib/types";
import { isCuid, isStreet, toFloat } from "@/lib/validate";

export const runtime = "nodejs";

// Hard cap so an unfiltered export can't stream the whole mart.
const EXPORT_CAP = 5000;
const PAGE_SIZE = 100;

const HEADER = [
  "started_at",
  "hand_id",
  "seat1_name",
  "seat1_hole",
  "seat1_result_bb",
  "seat2_name",
  "seat2_hole",
  "seat2_result_bb",
  "board",
  "pot_bb",
  "street_reached",
  "is_mirror",
  "mirror_hand_id",
];

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toRow(h: HandListRow): string {
  return [
    h.startedAt,
    h.handId,
    h.agent1Name,
    h.agent1Hole ? h.agent1Hole.join(" ") : null,
    h.agent1ResultBb,
    h.agent2Name,
    h.agent2Hole ? h.agent2Hole.join(" ") : null,
    h.agent2ResultBb,
    h.boardCards ? h.boardCards.join(" ") : null,
    h.finalPotChips === null ? null : chipsToBb(h.finalPotChips),
    h.streetReached,
    h.mirrorHandId ? "true" : "false",
    h.mirrorHandId,
  ]
    .map(csvCell)
    .join(",");
}

export async function GET(req: NextRequest) {
  return guarded(async () => {
    const sp = req.nextUrl.searchParams;

    // Same filter params as /api/hands; limit/cursor are ignored — the export
    // always walks the keyset cursor with full-size pages.
    const agentId = sp.get("agentId");
    if (agentId && !isCuid(agentId)) return badRequest("invalid agentId");
    const opponentId = sp.get("opponentId");
    if (opponentId && !isCuid(opponentId)) return badRequest("invalid opponentId");

    const street = sp.get("street");
    const minPotBb = toFloat(sp.get("minPotBb"));
    const showdownOnly = sp.get("showdownOnly") === "true";
    const mirrorOnly = sp.get("mirrorOnly") === "true";

    const rows: HandListRow[] = [];
    let cursor: string | null = null;
    while (rows.length < EXPORT_CAP) {
      const page = await listHands({
        agentId: agentId || null,
        opponentId: opponentId || null,
        street: isStreet(street) ? street : null,
        minPotBb,
        showdownOnly,
        mirrorOnly,
        limit: PAGE_SIZE,
        cursor,
      });
      rows.push(...page.hands);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    const csv = [HEADER.join(","), ...rows.slice(0, EXPORT_CAP).map(toRow)].join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="hands.csv"',
        "Cache-Control": "no-store",
      },
    });
  });
}
