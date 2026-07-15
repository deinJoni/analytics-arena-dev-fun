import { NextResponse } from "next/server";

export const LIST_CACHE = "s-maxage=60, stale-while-revalidate=300";
export const DETAIL_CACHE = "no-store";

export function ok(data: unknown, cache: string = LIST_CACHE): NextResponse {
  return NextResponse.json(data, { headers: { "Cache-Control": cache } });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function notFound(message = "not found"): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

// Wrap a handler so DB/internal error text never leaks to the client.
export async function guarded(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    console.error("[api]", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
