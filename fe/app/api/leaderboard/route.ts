import { guarded, ok } from "@/lib/api-helpers";
import { getLeaderboard } from "@/lib/queries/leaderboard";

export const runtime = "nodejs";

export async function GET() {
  return guarded(async () => ok(await getLeaderboard()));
}
