import { guarded, ok } from "@/lib/api-helpers";
import { getMatchups } from "@/lib/queries/matchups";

export const runtime = "nodejs";

export async function GET() {
  return guarded(async () => ok(await getMatchups()));
}
