import { badRequest, guarded, notFound, ok } from "@/lib/api-helpers";
import { getAgentStats } from "@/lib/queries/agentStats";
import { getLeaderboardRow } from "@/lib/queries/leaderboard";
import { isCuid } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  return guarded(async () => {
    const { agentId } = await params;
    if (!isCuid(agentId)) return badRequest("invalid agentId");

    const [header, splits] = await Promise.all([
      getLeaderboardRow(agentId),
      getAgentStats(agentId),
    ]);
    if (!header) return notFound("agent not found");
    return ok({ header, splits });
  });
}
