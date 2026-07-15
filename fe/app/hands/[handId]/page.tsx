"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import type { HandDetailResponse, HandStep } from "@/lib/types";
import { fmtTime, shortId } from "@/lib/format";
import { HandPanel } from "@/components/replayer/hand-panel";
import { ErrorState, TableSkeleton } from "@/components/ui";

// First decision index where the two playings of the same deck differ.
// null = never diverge (or nothing to compare).
function firstDivergence(a: HandStep[], b: HandStep[]): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (
      a[i].street !== b[i].street ||
      a[i].action !== b[i].action ||
      a[i].sizeBb !== b[i].sizeBb
    ) {
      return i;
    }
  }
  return a.length === b.length ? null : n;
}

export default function ReplayerPage({
  params,
}: {
  params: Promise<{ handId: string }>;
}) {
  const { handId } = use(params);
  const hand = useApi<HandDetailResponse>(`/api/hands/${handId}`);

  const [step, setStep] = useState(-1);
  const [mirrorStep, setMirrorStep] = useState(-1);
  const [showMirror, setShowMirror] = useState(false);

  const divergeAt = useMemo(() => {
    if (!hand.data?.mirror) return null;
    return firstDivergence(hand.data.steps, hand.data.mirror.steps);
  }, [hand.data]);

  // keyboard transport for the primary hand
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const n = hand.data?.steps.length ?? 0;
      if (e.key === "ArrowRight") setStep((s) => Math.min(n - 1, s + 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(-1, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hand.data?.steps.length]);

  if (hand.isPending) {
    return <div className="card"><TableSkeleton rows={12} /></div>;
  }
  if (hand.isError) {
    return <ErrorState message={(hand.error as Error)?.message} retry={() => hand.refetch()} />;
  }

  const { header, steps, mirror } = hand.data;

  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink3">
        <span>
          <Link href="/hands" className="hover:text-ink2">hands</Link>
          <span className="mx-1.5">/</span>
          <span className="font-mono text-ink2">{shortId(header.handId, 8)}</span>
        </span>
        <span className="font-mono">
          block {shortId(header.blockId)} · pair {header.pairIndex ?? "—"} · dealt{" "}
          {header.orientation === 1 ? "first" : header.orientation === 2 ? "second (mirror)" : "—"} ·{" "}
          {fmtTime(header.startedAt)}
        </span>
      </nav>

      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">hand replayer</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            {header.agent1Name} vs {header.agent2Name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <p className="max-w-56 text-right text-[10px] leading-tight text-ink3">
            equity bars are omniscient (vs actual cards) — a hindsight readout, not a GTO score
          </p>
          <button
            onClick={() => setShowMirror((v) => !v)}
            disabled={!mirror}
            title={
              mirror
                ? "show the partner hand: same deck, seats swapped"
                : "mirror hand not ingested (yet) for this deck"
            }
            className={`rounded border px-4 py-2 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              showMirror
                ? "border-accent bg-surface2 text-accent"
                : "border-line bg-surface2 text-ink2 hover:border-accent"
            }`}
          >
            ⧉ mirror {showMirror ? "on" : "off"}
          </button>
        </div>
      </section>

      <div className={showMirror && mirror ? "grid gap-4 xl:grid-cols-2" : ""}>
        <HandPanel
          header={header}
          steps={steps}
          step={step}
          onStep={setStep}
          divergeAt={showMirror ? divergeAt : null}
          tag={showMirror ? "this hand" : undefined}
        />
        {showMirror && mirror && (
          <HandPanel
            header={mirror.header}
            steps={mirror.steps}
            step={mirrorStep}
            onStep={setMirrorStep}
            divergeAt={divergeAt}
            tag="mirror — identical deck, seats swapped"
          />
        )}
      </div>

      {showMirror && mirror && (
        <p className="text-[11px] text-ink3">
          Hole cards stay glued to the seat while the agents swap — each bot played both sides
          of this exact deck. Diff their lines and reasoning from the divergence marker down.
          {divergeAt === null && " These two playings never diverged."}
        </p>
      )}
      <p className="text-[11px] text-ink3">
        keyboard: <span className="font-mono text-ink2">←</span> /{" "}
        <span className="font-mono text-ink2">→</span> step the left panel
      </p>
    </div>
  );
}
