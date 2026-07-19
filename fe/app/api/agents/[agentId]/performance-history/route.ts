import { LIST_CACHE, badRequest, guarded, ok } from "@/lib/api-helpers";
import { getAgentPerformanceHistory } from "@/lib/queries/agentPerformanceHistory";
import { isCuid } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  return guarded(async () => {
    const { agentId } = await params;
    if (!isCuid(agentId)) return badRequest("invalid agentId");
    const points = await getAgentPerformanceHistory(agentId);
    return ok({ agentId, points }, LIST_CACHE);
  });
}
