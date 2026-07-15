// Arena ids are cuids: "c" + lowercase alphanum, ~25 chars.
const CUID = /^c[a-z0-9]{8,40}$/;

export function isCuid(s: unknown): s is string {
  return typeof s === "string" && CUID.test(s);
}

export const STREETS = ["Preflop", "Flop", "Turn", "River", "Showdown"] as const;
export type Street = (typeof STREETS)[number];

export function isStreet(s: unknown): s is Street {
  return typeof s === "string" && (STREETS as readonly string[]).includes(s);
}

export const POSITIONS = ["IP", "OOP"] as const;
export function isPosition(s: unknown): s is "IP" | "OOP" {
  return s === "IP" || s === "OOP";
}

export const TEXTURES = ["dry", "semi_wet", "wet", "na"] as const;
export function isTexture(s: unknown): s is (typeof TEXTURES)[number] {
  return typeof s === "string" && (TEXTURES as readonly string[]).includes(s);
}

export function toInt(
  s: string | null,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (s === null || s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function toFloat(s: string | null): number | null {
  if (s === null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
