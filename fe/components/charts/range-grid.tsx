"use client";

import type { RangeCombo, RangeNode, RangeNodeAction } from "@/lib/types";

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];

// Action identity colors (categorical, validated dark palette):
// aggressive = blue, passive-continue = yellow, fold recedes into the felt.
export const ACTION_COLOR: Record<string, string> = {
  raise: "#3987e5",
  call: "#c98500",
  check: "#c98500",
  fold: "#40453d",
};

export const NODE_META: Record<
  RangeNode,
  { title: string; verbs: Record<string, string>; desc: string }
> = {
  ip_first: {
    title: "IP · first decision",
    verbs: { raise: "open", call: "limp", fold: "fold" },
    desc: "on the button (acts first): open-raise, limp, or fold",
  },
  oop_vs_open: {
    title: "OOP · facing an open",
    verbs: { raise: "3-bet", call: "call", fold: "fold" },
    desc: "in the big blind facing the button's open-raise",
  },
  oop_vs_limp: {
    title: "OOP · facing a limp",
    verbs: { raise: "iso-raise", check: "check", call: "call" },
    desc: "in the big blind after the button limps",
  },
  ip_vs_3bet: {
    title: "IP · facing a 3-bet",
    verbs: { raise: "4-bet", call: "call", fold: "fold" },
    desc: "on the button after its open gets 3-bet",
  },
};

const SEGMENT_ORDER = ["raise", "call", "check", "fold"];

// row i, col j: diagonal = pair, upper-right = suited, lower-left = offsuit
function cellLabel(i: number, j: number): string {
  if (i === j) return RANKS[i] + RANKS[j];
  if (i < j) return RANKS[i] + RANKS[j] + "s";
  return RANKS[j] + RANKS[i] + "o";
}

function nodeOpp(c: RangeCombo | undefined, node: RangeNode): number {
  return (c?.nodes[node] ?? []).reduce((s, a) => s + a.n, 0);
}

function sortedActions(actions: RangeNodeAction[]): RangeNodeAction[] {
  return [...actions].sort(
    (a, b) => SEGMENT_ORDER.indexOf(a.action) - SEGMENT_ORDER.indexOf(b.action),
  );
}

// One 13x13 grid for a single decision node. Each tile splits into colored
// segments proportional to the action mix — the whole strategy in one look.
//
// Mobile: the grid is fluid (w-full), tiles touch (gap-0) so they stay ~26px at
// 390px, and labels bump to 9px. Hover-preview only applies on hover-capable
// pointers — on touch, the tap itself must toggle selection (a synthetic
// mouseenter/focus before the click would otherwise instantly undo it).
function hoverCapable(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches;
}

export function RangeStrategyGrid({
  combos,
  node,
  selected,
  onSelect,
}: {
  combos: Map<string, RangeCombo>;
  node: RangeNode;
  selected: string | null;
  onSelect: (hand: string | null) => void;
}) {
  const meta = NODE_META[node];
  let totalOpp = 0;
  combos.forEach((c) => (totalOpp += nodeOpp(c, node)));

  return (
    <div className="min-w-0 flex-1">
      <p className="eyebrow">{meta.title}</p>
      <p className="mb-2 mt-0.5 text-[11px] text-ink3">
        {meta.desc} · {totalOpp} decisions
      </p>
      <div
        className="grid w-full max-w-[380px] select-none gap-0 sm:gap-px"
        style={{ gridTemplateColumns: "repeat(13, minmax(0, 1fr))" }}
      >
        {RANKS.map((_, i) =>
          RANKS.map((_, j) => {
            const label = cellLabel(i, j);
            const c = combos.get(label);
            const actions = sortedActions(c?.nodes[node] ?? []);
            const opp = actions.reduce((s, a) => s + a.n, 0);
            const isSel = selected === label;
            return (
              <button
                key={label + i + "-" + j}
                onMouseEnter={() => hoverCapable() && onSelect(label)}
                onFocus={() => hoverCapable() && onSelect(label)}
                onClick={() => onSelect(isSel ? null : label)}
                aria-pressed={isSel}
                aria-label={`${label}: ${
                  opp === 0
                    ? "no decisions here"
                    : actions.map((a) => `${meta.verbs[a.action] ?? a.action} ${a.n}`).join(", ")
                }`}
                className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-[2px] font-mono text-[9px] leading-none sm:text-[8px] ${
                  opp === 0 ? "border border-line/50 text-ink3/50" : "text-ink"
                } ${isSel ? "z-10 outline outline-1 outline-accent" : ""}`}
              >
                {opp > 0 && (
                  <span className="absolute inset-0 flex">
                    {actions.map((a) => (
                      <span
                        key={a.action}
                        style={{
                          width: `${(a.n / opp) * 100}%`,
                          background: ACTION_COLOR[a.action] ?? "#40453d",
                        }}
                      />
                    ))}
                  </span>
                )}
                <span
                  className="relative"
                  style={opp > 0 ? { textShadow: "0 0 3px rgba(0,0,0,0.9)" } : undefined}
                >
                  {label}
                </span>
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}

function ActionDot({ action }: { action: string }) {
  return (
    <span
      className="inline-block h-2 w-2 rounded-[2px] align-middle"
      style={{ background: ACTION_COLOR[action] ?? "#40453d" }}
    />
  );
}

function fmtBb100(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(0)} bb/100`;
}

// Right-hand explainer on desktop, stacks below the grids on mobile.
// No selection -> how to read the charts; combo selected -> its full breakdown.
export function RangeInfoPanel({
  combos,
  selected,
}: {
  combos: Map<string, RangeCombo>;
  selected: string | null;
}) {
  const c = selected ? combos.get(selected) : undefined;

  if (!selected) {
    return (
      <div className="rounded border border-line bg-surface2/50 p-3 text-[11px] leading-relaxed text-ink3 lg:w-64 lg:shrink-0">
        <p className="eyebrow mb-2">how to read this</p>
        <p>
          Each tile is one starting combo — pairs on the diagonal, suited upper-right,
          offsuit lower-left. The tile splits by what the bot actually did there:
        </p>
        <p className="mt-2 space-y-1">
          <span className="block">
            <ActionDot action="raise" /> <span className="text-ink2">raise</span> — open / 3-bet
            / 4-bet / iso, depending on the node
          </span>
          <span className="block">
            <ActionDot action="call" /> <span className="text-ink2">call / check</span> — the
            passive continue
          </span>
          <span className="block">
            <ActionDot action="fold" /> <span className="text-ink2">fold</span>
          </span>
        </p>
        <p className="mt-2">
          A tile that is all blue is a pure raise; half blue, half dark = raised 50%, folded
          50%. Outlined tiles never faced that decision.
        </p>
        <p className="mt-2 text-ink2">Hover or tap a tile for its full breakdown.</p>
      </div>
    );
  }

  const nodes = (Object.keys(NODE_META) as RangeNode[]).map((n) => ({
    node: n,
    meta: NODE_META[n],
    actions: sortedActions(c?.nodes[n] ?? []),
  }));

  return (
    <div className="rounded border border-line bg-surface2/50 p-3 text-[11px] leading-relaxed lg:w-64 lg:shrink-0">
      <p className="font-mono text-base font-semibold text-ink">{selected}</p>
      <p className="mt-0.5 text-ink3">
        dealt {c?.dealtN ?? 0}× ·{" "}
        <span className="num">{fmtBb100(c?.bbPer100 ?? null)}</span> overall
        {c?.winRate != null && ` · won ${Math.round(c.winRate * 100)}%`}
      </p>
      <div className="mt-3 space-y-3">
        {nodes.map(({ node, meta, actions }) => {
          const opp = actions.reduce((s, a) => s + a.n, 0);
          return (
            <div key={node}>
              <p className="eyebrow">{meta.title}</p>
              {opp === 0 ? (
                <p className="text-ink3">never faced this decision with {selected}</p>
              ) : (
                <div className="mt-1 space-y-0.5">
                  {actions.map((a) => (
                    <p key={a.action} className="text-ink2">
                      <ActionDot action={a.action} />{" "}
                      {meta.verbs[a.action] ?? a.action} {a.n} of {opp}{" "}
                      <span className="num text-accent">({Math.round((a.n / opp) * 100)}%)</span>
                      {a.bbPer100 !== null && (
                        <span className="text-ink3">
                          {" "}
                          → <span className="num">{fmtBb100(a.bbPer100)}</span>
                        </span>
                      )}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-ink3">
        thin samples read as noise — check the deal count before trusting a mix
      </p>
    </div>
  );
}
