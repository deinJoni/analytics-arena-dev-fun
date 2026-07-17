import { badRequest, guarded, ok } from "@/lib/api-helpers";
import { getRankHistory } from "@/lib/queries/rankHistory";
import { isCuid } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  return guarded(async () => {
    const { agentId } = await params;
    if (!isCuid(agentId)) return badRequest("invalid agentId");
    const points = await getRankHistory(agentId);
    return ok({ agentId, points });
  });
}
