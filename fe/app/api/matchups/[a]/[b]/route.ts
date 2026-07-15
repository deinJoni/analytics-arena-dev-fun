import { badRequest, guarded, notFound, ok } from "@/lib/api-helpers";
import { getMatchupDetail } from "@/lib/queries/matchups";
import { isCuid } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ a: string; b: string }> },
) {
  return guarded(async () => {
    const { a, b } = await params;
    if (!isCuid(a) || !isCuid(b)) return badRequest("invalid agent id");

    const detail = await getMatchupDetail(a, b);
    if (!detail) return notFound("matchup not found");
    return ok(detail);
  });
}
