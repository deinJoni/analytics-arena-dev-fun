import { type NextRequest } from "next/server";
import { badRequest, guarded, ok } from "@/lib/api-helpers";
import { listHands } from "@/lib/queries/hands";
import { isCuid, isStreet, toFloat, toInt } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return guarded(async () => {
    const sp = req.nextUrl.searchParams;

    const agentId = sp.get("agentId");
    if (agentId && !isCuid(agentId)) return badRequest("invalid agentId");
    const opponentId = sp.get("opponentId");
    if (opponentId && !isCuid(opponentId)) return badRequest("invalid opponentId");

    const street = sp.get("street");

    const result = await listHands({
      agentId: agentId || null,
      opponentId: opponentId || null,
      street: isStreet(street) ? street : null,
      minPotBb: toFloat(sp.get("minPotBb")),
      showdownOnly: sp.get("showdownOnly") === "true",
      mirrorOnly: sp.get("mirrorOnly") === "true",
      limit: toInt(sp.get("limit"), { min: 1, max: 100, fallback: 50 }),
      cursor: sp.get("cursor"),
    });
    return ok(result);
  });
}
