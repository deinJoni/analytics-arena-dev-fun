"use client";

import { useQuery } from "@tanstack/react-query";

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json();
}

// Thin wrapper: one API path -> one cached query.
export function useApi<T>(path: string | null) {
  return useQuery<T>({
    queryKey: ["api", path],
    queryFn: () => fetchJson<T>(path as string),
    enabled: path !== null,
  });
}
