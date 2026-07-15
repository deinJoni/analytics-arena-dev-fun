import { guarded, ok } from "@/lib/api-helpers";
import { getSeason } from "@/lib/queries/season";

export const runtime = "nodejs";

export async function GET() {
  return guarded(async () => ok(await getSeason()));
}
