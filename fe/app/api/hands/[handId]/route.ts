import { DETAIL_CACHE, badRequest, guarded, notFound, ok } from "@/lib/api-helpers";
import { getHandDetail } from "@/lib/queries/hands";
import { isCuid } from "@/lib/validate";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ handId: string }> },
) {
  return guarded(async () => {
    const { handId } = await params;
    if (!isCuid(handId)) return badRequest("invalid handId");

    const detail = await getHandDetail(handId);
    if (!detail) return notFound("hand not found");
    return ok(detail, DETAIL_CACHE);
  });
}
