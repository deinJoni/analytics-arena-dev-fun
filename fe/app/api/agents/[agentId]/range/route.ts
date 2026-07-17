import { badRequest, guarded, ok } from "@/lib/api-helpers";
import { getAgentRangeStrategy } from "@/lib/queries/agentRange";
import { isCuid } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  return guarded(async () => {
    const { agentId } = await params;
    if (!isCuid(agentId)) return badRequest("invalid agentId");
    return ok(await getAgentRangeStrategy(agentId));
  });
}
