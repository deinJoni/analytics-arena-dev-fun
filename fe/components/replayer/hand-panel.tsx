"use client";

import type { HandHeader, HandStep } from "@/lib/types";
import { chipsToBb, fmtBb, signClass } from "@/lib/format";
import { CardRow } from "@/components/playing-card";
import { AgentLink } from "@/components/agent-link";

const STREET_TAG: Record<string, string> = {
  Preflop: "PF",
  Flop: "F",
  Turn: "T",
  River: "R",
  Showdown: "SD",
};

export function actionText(s: HandStep): string {
  let t = s.action ?? "?";
  if (s.sizeBb !== null) t += ` ${s.sizeBb}bb`;
  if (s.sizePotFraction !== null) t += ` · ${Math.round(s.sizePotFraction * 100)}% pot`;
  return t;
}

function Seat({
  name,
  agentId,
  hole,
  resultBb,
  isButton,
  winner,
}: {
  name: string | null;
  agentId: string | null;
  hole: string[] | null;
  resultBb: number | null;
  isButton: boolean;
  winner: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <CardRow cards={hole} size="md" placeholders={2} />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm">
          <AgentLink agentId={agentId} name={name} className="truncate" />
          {isButton && (
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-cardface font-mono text-[9px] font-semibold text-suitblack"
              title="button (dealer / in position)"
            >
              D
            </span>
          )}
          {winner && <span className="text-[10px] text-accent" title="won the pot">●</span>}
        </p>
        <p className={`num text-xs ${signClass(resultBb)}`}>{fmtBb(resultBb, 1)} bb</p>
      </div>
    </div>
  );
}

// One hand rendered as felt + timeline. Controlled: parent owns the step index.
export function HandPanel({
  header,
  steps,
  step,
  onStep,
  divergeAt,
  tag,
}: {
  header: HandHeader;
  steps: HandStep[];
  step: number; // -1 = pre-deal, otherwise index into steps
  onStep: (i: number) => void;
  divergeAt?: number | null; // first step index where this hand's line differs from its mirror
  tag?: string;
}) {
  const cur = step >= 0 ? steps[Math.min(step, steps.length - 1)] : undefined;
  const board = cur?.boardSoFar ?? (step >= 0 ? header.boardCards : []) ?? [];
  const potChips = cur?.potAfter ?? (step >= 0 ? header.finalPotChips : 15);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-4">
          <Seat
            name={header.agent1Name}
            agentId={header.agent1Id}
            hole={header.agent1Hole}
            resultBb={header.agent1ResultBb}
            isButton={header.agent1IsButton === true}
            winner={header.winnerAgentId === header.agent1Id}
          />
          <span className="eyebrow">vs</span>
          <Seat
            name={header.agent2Name}
            agentId={header.agent2Id}
            hole={header.agent2Hole}
            resultBb={header.agent2ResultBb}
            isButton={header.agent1IsButton === false}
            winner={header.winnerAgentId === header.agent2Id}
          />
        </div>
        {tag && <span className="eyebrow shrink-0 text-accent">{tag}</span>}
      </div>

      {/* felt */}
      <div
        className="mx-4 mt-4 rounded-2xl border border-feltedge px-4 py-5 text-center"
        style={{ background: "radial-gradient(ellipse at center, var(--felt) 0%, #102717 100%)" }}
      >
        <CardRow cards={board} size="lg" placeholders={5} />
        <p className="num mt-3 text-sm text-ink">
          pot {potChips === null ? "—" : `${chipsToBb(potChips).toFixed(1)} bb`}
        </p>
        <p className="eyebrow mt-1">
          {step < 0 ? "pre-deal" : (cur?.street ?? header.streetReached ?? "")}
        </p>
      </div>

      {/* transport */}
      <div className="flex items-center justify-center gap-2 px-4 py-3">
        <button
          onClick={() => onStep(-1)}
          disabled={step < 0}
          className="rounded border border-line bg-surface2 px-2.5 py-1 font-mono text-xs text-ink2 hover:border-accent disabled:opacity-40"
          title="reset"
        >
          ⏮
        </button>
        <button
          onClick={() => onStep(Math.max(-1, step - 1))}
          disabled={step < 0}
          className="rounded border border-line bg-surface2 px-2.5 py-1 font-mono text-xs text-ink2 hover:border-accent disabled:opacity-40"
        >
          ← prev
        </button>
        <span className="num w-16 text-center text-xs text-ink3">
          {step + 1} / {steps.length}
        </span>
        <button
          onClick={() => onStep(Math.min(steps.length - 1, step + 1))}
          disabled={step >= steps.length - 1}
          className="rounded border border-line bg-surface2 px-2.5 py-1 font-mono text-xs text-ink2 hover:border-accent disabled:opacity-40"
        >
          next →
        </button>
        <button
          onClick={() => onStep(steps.length - 1)}
          disabled={step >= steps.length - 1}
          className="rounded border border-line bg-surface2 px-2.5 py-1 font-mono text-xs text-ink2 hover:border-accent disabled:opacity-40"
          title="jump to end"
        >
          ⏭
        </button>
      </div>

      {/* timeline */}
      <ol className="max-h-[420px] overflow-y-auto border-t border-line">
        {steps.length === 0 && (
          <li className="px-4 py-6 text-center text-xs text-ink3">
            no decision steps recorded for this hand
          </li>
        )}
        {steps.map((s, i) => {
          const active = i === step;
          const diverged = divergeAt !== null && divergeAt !== undefined && i === divergeAt;
          return (
            <li key={s.sequence}>
              {diverged && (
                <div className="flex items-center gap-2 bg-surface2 px-4 py-1.5">
                  <span className="font-mono text-[10px] tracking-widest text-accent">
                    ⟂ LINES DIVERGE HERE
                  </span>
                </div>
              )}
              <button
                onClick={() => onStep(i)}
                className={`block w-full border-l-2 px-4 py-2 text-left transition-colors ${
                  active
                    ? "border-accent bg-surface2"
                    : "border-transparent hover:bg-surface2/60"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="num w-8 shrink-0 text-[10px] text-ink3">
                    {STREET_TAG[s.street ?? ""] ?? "·"}
                    {s.sequence}
                  </span>
                  <span className="w-28 shrink-0 truncate text-xs text-ink2">{s.actorName}</span>
                  <span className="flex-1 font-mono text-xs text-ink">{actionText(s)}</span>
                  <span className="num shrink-0 text-[11px] text-ink3">
                    pot {s.potAfter === null ? "—" : chipsToBb(s.potAfter).toFixed(1)}
                  </span>
                  {s.equityAtDecision !== null && (
                    <span
                      className="flex w-20 shrink-0 items-center gap-1.5"
                      title="omniscient equity vs the opponent's actual cards — a hindsight readout, not a GTO score"
                    >
                      <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-line">
                        <span
                          className="absolute inset-y-0 left-0 rounded"
                          style={{
                            width: `${s.equityAtDecision * 100}%`,
                            background:
                              s.equityAtDecision >= 0.5 ? "var(--pos)" : "var(--neg)",
                          }}
                        />
                      </span>
                      <span className="num text-[10px] text-ink3">
                        {Math.round(s.equityAtDecision * 100)}
                      </span>
                    </span>
                  )}
                </div>
                {s.reasoningText && (
                  <p className="mt-1 pl-10 font-mono text-[11px] leading-relaxed text-ink3">
                    <span className="text-feltedge">└ </span>
                    {s.reasoningText}
                  </p>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
