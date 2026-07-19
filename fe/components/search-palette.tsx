"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api";
import { fmt1 } from "@/lib/format";
import type { LeaderboardRow } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Fuzzy matching (zero-dependency, exported for reuse)                */
/* ------------------------------------------------------------------ */

export type AgentMatchField = "name" | "handle" | "id";

export interface AgentSearchResult {
  row: LeaderboardRow;
  /** Higher is better. */
  score: number;
  /** Which field the query matched. */
  field: AgentMatchField;
  /** Indices of matched chars within the matched field's string (for highlight). */
  indices: number[];
}

const FIELD_BASE: Record<AgentMatchField, number> = {
  name: 300,
  handle: 200,
  id: 100,
};

/**
 * Greedy case-insensitive subsequence match of `query` against `text`.
 * Returns a score (higher = better: earlier start, tighter span, word-boundary
 * hits) plus the matched character indices, or null when the query is not a
 * subsequence of the text.
 */
function subsequenceScore(
  query: string,
  text: string,
): { score: number; indices: number[] } | null {
  if (!query) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    indices.push(found);
    ti = found + 1;
  }
  const start = indices[0];
  const span = indices[indices.length - 1] - start + 1;
  let score = 100 - start * 2 - (span - q.length) * 3;
  // Contiguous run bonus ("jon" in "joni" reads much better than scattered hits).
  if (span === q.length) score += 40;
  // Word / string boundary bonus for the first matched char.
  if (start === 0 || /[\s\-_.@]/.test(text[start - 1])) score += 25;
  // Prefer shorter candidates (less noise around the match).
  score -= Math.min(text.length - q.length, 40) * 0.5;
  return { score, indices };
}

function bestFieldScore(
  query: string,
  row: LeaderboardRow,
): AgentSearchResult | null {
  const candidates: Array<[AgentMatchField, string | null]> = [
    ["name", row.agentName],
    ["handle", row.agentHandle],
    ["id", row.agentId],
  ];
  let best: AgentSearchResult | null = null;
  for (const [field, text] of candidates) {
    if (!text) continue;
    const hit = subsequenceScore(query, text);
    if (!hit) continue;
    const score = FIELD_BASE[field] + hit.score;
    if (!best || score > best.score) {
      best = { row, score, field, indices: hit.indices };
    }
  }
  return best;
}

/**
 * Fuzzy-search agents: matches the query as a case-insensitive subsequence
 * against agentName first, then agentHandle, then agentId. Returns up to
 * `limit` results ordered by match quality (ties broken by ladder rank).
 * An empty/blank query returns the top `limit` rows by rank with no highlight.
 */
export function fuzzyMatchAgents(
  query: string,
  rows: LeaderboardRow[],
  limit = 8,
): AgentSearchResult[] {
  const q = query.trim();
  if (!q) {
    return [...rows]
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
      .slice(0, limit)
      .map((row) => ({ row, score: 0, field: "name" as const, indices: [] }));
  }
  const results: AgentSearchResult[] = [];
  for (const row of rows) {
    const hit = bestFieldScore(q, row);
    if (hit) results.push(hit);
  }
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.row.rank ?? Infinity) - (b.row.rank ?? Infinity);
  });
  return results.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Highlighted text                                                    */
/* ------------------------------------------------------------------ */

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marks = new Set(indices);
  const parts: React.ReactNode[] = [];
  let run = "";
  let runMatch = marks.has(0);
  for (let i = 0; i < text.length; i++) {
    const isMatch = marks.has(i);
    if (i > 0 && isMatch !== runMatch) {
      parts.push(
        runMatch ? (
          <span key={i} className="text-accent">
            {run}
          </span>
        ) : (
          run
        ),
      );
      run = "";
      runMatch = isMatch;
    }
    run += text[i];
  }
  parts.push(
    runMatch ? (
      <span key={text.length} className="text-accent">
        {run}
      </span>
    ) : (
      run
    ),
  );
  return <>{parts}</>;
}

/* ------------------------------------------------------------------ */
/* Search palette modal                                                */
/* ------------------------------------------------------------------ */

export interface SearchPaletteProps {
  /**
   * When provided, selecting a result calls this instead of navigating to
   * the agent page (lets a comparison page reuse the palette as a picker).
   */
  onSelect?: (row: LeaderboardRow) => void;
  /** Controlled open state. Omit to let the palette manage it internally. */
  open?: boolean;
  /** Called whenever the palette wants to open or close (⌘K, Esc, backdrop…). */
  onOpenChange?: (open: boolean) => void;
}

export function SearchPalette({ onSelect, open, onOpenChange }: SearchPaletteProps) {
  const router = useRouter();
  const board = useApi<LeaderboardRow[]>("/api/leaderboard");
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = open ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const results = useMemo(
    () => fuzzyMatchAgents(query, board.data ?? []),
    [query, board.data],
  );

  // Global hotkeys: ⌘K / Ctrl+K toggles, "/" opens (outside of inputs).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!isOpen);
        return;
      }
      if (e.key === "/" && !isOpen) {
        const el = document.activeElement;
        const tag = el?.tagName;
        const typing =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          (el instanceof HTMLElement && el.isContentEditable);
        if (!typing) {
          e.preventDefault();
          setOpen(true);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setOpen]);

  // Reset + autofocus whenever the palette opens.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActive(0);
      // wait a frame so the input is mounted
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Clamp the active row when the result list changes.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const choose = useCallback(
    (row: LeaderboardRow) => {
      setOpen(false);
      if (onSelect) {
        onSelect(row);
      } else {
        router.push(`/agents/${row.agentId}`);
      }
    },
    [onSelect, router, setOpen],
  );

  if (!isOpen) return null;

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) choose(hit.row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 px-4 pt-[15vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search agents"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="shrink-0 text-ink3"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search agents by name or handle…"
            aria-label="Search agents"
            role="combobox"
            aria-expanded="true"
            aria-controls="search-palette-results"
            aria-activedescendant={
              results[active] ? `search-palette-option-${active}` : undefined
            }
            className="h-11 w-full bg-transparent text-sm text-ink placeholder:text-ink3 focus:outline-none"
          />
          <kbd className="num shrink-0 rounded border border-line bg-surface2 px-1.5 py-0.5 text-[10px] text-ink3">
            esc
          </kbd>
        </div>

        <ul
          id="search-palette-results"
          role="listbox"
          aria-label="Matching agents"
          className="max-h-80 overflow-y-auto py-1"
        >
          {board.isLoading && (
            <li className="px-3 py-3 text-sm text-ink3">Loading agents…</li>
          )}
          {!board.isLoading && results.length === 0 && (
            <li className="px-3 py-3 text-sm text-ink3">
              No agents match “{query}”.
            </li>
          )}
          {results.map((hit, i) => {
            const { row } = hit;
            const name = row.agentName ?? row.agentHandle ?? row.agentId;
            const selected = i === active;
            return (
              <li
                key={row.agentId}
                id={`search-palette-option-${i}`}
                role="option"
                aria-selected={selected}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${
                  selected ? "bg-surface2" : ""
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(row)}
              >
                <span className="num w-8 shrink-0 text-right text-xs text-ink3">
                  {row.rank !== null ? `#${row.rank}` : "—"}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {hit.field === "name" ? (
                    <Highlighted text={name} indices={hit.indices} />
                  ) : (
                    name
                  )}
                  {row.agentHandle && (
                    <span className="ml-2 text-xs text-ink3">
                      {hit.field === "handle" ? (
                        <Highlighted
                          text={row.agentHandle}
                          indices={hit.indices}
                        />
                      ) : (
                        row.agentHandle
                      )}
                    </span>
                  )}
                </span>
                <span className="num shrink-0 text-xs text-ink2">
                  {fmt1(row.trueskillMu)}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink3">
          <span className="num">↑↓ navigate</span>
          <span className="num">↵ open</span>
          <span className="num">esc close</span>
        </div>
      </div>
    </div>
  );
}
