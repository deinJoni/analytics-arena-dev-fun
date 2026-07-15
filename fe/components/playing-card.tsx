const SUITS: Record<string, { glyph: string; red: boolean }> = {
  s: { glyph: "♠", red: false },
  h: { glyph: "♥", red: true },
  d: { glyph: "♦", red: true },
  c: { glyph: "♣", red: false },
};

const SIZE = {
  sm: "h-[22px] w-[16px] text-[10px] rounded-[3px]",
  md: "h-[34px] w-[25px] text-[13px] rounded",
  lg: "h-[52px] w-[38px] text-lg rounded-md",
};

export function PlayingCard({
  card,
  size = "sm",
}: {
  card: string; // e.g. "Kh", "Td"
  size?: keyof typeof SIZE;
}) {
  const rank = card.slice(0, -1).replace("T", "10");
  const suit = SUITS[card.slice(-1).toLowerCase()];
  if (!suit) return null;
  return (
    <span
      className={`inline-flex flex-col items-center justify-center bg-cardface font-mono font-semibold leading-none shadow-sm ${SIZE[size]} ${
        suit.red ? "text-suitred" : "text-suitblack"
      }`}
      aria-label={card}
    >
      <span>{rank}</span>
      <span className="mt-px">{suit.glyph}</span>
    </span>
  );
}

export function CardRow({
  cards,
  size = "sm",
  placeholders = 0,
}: {
  cards: string[] | null | undefined;
  size?: keyof typeof SIZE;
  placeholders?: number; // render empty slots up to this count (board)
}) {
  const shown = cards ?? [];
  const empty = Math.max(0, placeholders - shown.length);
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {shown.map((c, i) => (
        <PlayingCard key={`${c}${i}`} card={c} size={size} />
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <span
          key={`e${i}`}
          className={`inline-block border border-dashed border-feltedge bg-transparent ${SIZE[size]}`}
          aria-hidden
        />
      ))}
    </span>
  );
}
