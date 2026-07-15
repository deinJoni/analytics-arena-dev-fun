import { type NextRequest } from "next/server";
import { badRequest, guarded, ok } from "@/lib/api-helpers";
import { getAgentLeaks } from "@/lib/queries/agentLeaks";
import { isCuid, isPosition, isStreet, isTexture, toInt } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  return guarded(async () => {
    const { agentId } = await params;
    if (!isCuid(agentId)) return badRequest("invalid agentId");

    const sp = req.nextUrl.searchParams;
    const position = sp.get("position");
    const street = sp.get("street");
    const texture = sp.get("texture");

    const rows = await getAgentLeaks(agentId, {
      position: isPosition(position) ? position : null,
      street: isStreet(street) ? street : null,
      texture: isTexture(texture) ? texture : null,
      minSampleN: toInt(sp.get("minSampleN"), { min: 1, max: 100000, fallback: 30 }),
    });
    return ok(rows);
  });
}
