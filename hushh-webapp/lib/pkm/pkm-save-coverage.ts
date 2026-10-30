/**
 * Line-by-line coverage of an explicit memory save. Pure: no network, no vault.
 *
 * Every non-blank line of the owner's text ends in exactly one place: saved
 * (with where), not memory (with why), a heading that attributes the lines
 * below it, held back (with why), or "not yet saved". A line counts as saved
 * or not-memory only when every letter and digit on it falls inside a span the
 * server committed or the agent marked as not memory. Markup and punctuation
 * (`-`, `**`, `#`, `:`) carry no fact and are not required to be quoted.
 *
 * Quotes are mapped back to absolute offsets with an ordered `indexOf` inside
 * the step that produced them (the step's start plus the match), so a fact
 * that appears twice is attributed to its own occurrence.
 */

import { toPlainMemoryText } from "@/lib/pkm/memory-plain-text";
import {
  isPkmSourceHeadingLine,
  pkmSourceLineSpans,
  type PkmSourceSpan,
} from "@/lib/pkm/pkm-source-chunks";

/** Why a line was accounted for without being saved. */
export type PkmCoverageNotMemoryReason = "duplicate" | "disclaimer" | "already_known";
/** Why a line is held back; each is a gap the owner can still act on. */
export type PkmCoverageHeldReason = "needs_owner" | "excluded" | "left_out";
export type PkmCoverageReason = PkmCoverageNotMemoryReason | PkmCoverageHeldReason | "heading" | "formatting";

export type PkmCoverageSpan = PkmSourceSpan &
  (
    | { kind: "committed"; cardId: string }
    | { kind: "not_memory"; reason: PkmCoverageNotMemoryReason }
    | { kind: "held"; reason: PkmCoverageHeldReason; cardId?: string }
  );

/** Where one committed card landed. `commitId` is the server's revision id when it returned one. */
export type PkmCoverageDestination = {
  cardId: string;
  domain: string;
  path: string | null;
  commitId: string | null;
};

export type PkmCoverageLineStatus = "saved" | "not_memory" | "structure" | "held" | "not_yet_saved";

export type PkmCoverageLine = {
  /** 1-based line number in the owner's text. */
  line: number;
  start: number;
  end: number;
  status: PkmCoverageLineStatus;
  reason?: PkmCoverageReason;
  destinations: PkmCoverageDestination[];
};

export type PkmLineCoverage = {
  lines: PkmCoverageLine[];
  totals: Record<PkmCoverageLineStatus, number> & { lines: number };
  /** Lines saved, not memory, or structural; held and unsaved lines are gaps. */
  accounted: number;
};

const CONTENT_CHARACTER = /[\p{L}\p{N}]/u;
const RANK = { none: 0, held: 1, not_memory: 2, committed: 3 } as const;

function plainLine(text: string): string {
  return toPlainMemoryText(text).replace(/\s+/g, " ").trim();
}

/**
 * The absolute span of `quote` inside a step: first at or after `cursor` within
 * `range`, then anywhere in `range`, then in the heading context sent with the
 * step. When the server quoted the text exactly this is an `indexOf`; the last
 * fallback matches a whole line whose plain text equals the plain quote, for a
 * quote whose Markdown was cleaned on the way back.
 */
export function locatePkmQuote(params: {
  source: string;
  range: PkmSourceSpan;
  context?: readonly PkmSourceSpan[];
  quote: string;
  cursor?: number;
}): PkmSourceSpan | null {
  const { source, range, quote } = params;
  if (!quote) return null;
  const within = (span: PkmSourceSpan, from: number): PkmSourceSpan | null => {
    const index = source.indexOf(quote, Math.max(span.start, from));
    return index >= 0 && index + quote.length <= span.end ? { start: index, end: index + quote.length } : null;
  };
  const ordered = params.cursor !== undefined ? within(range, params.cursor) : null;
  const found = ordered ?? within(range, range.start) ??
    (params.context ?? []).map((span) => within(span, span.start)).find(Boolean) ?? null;
  if (found) return found;
  const plainQuote = plainLine(quote);
  if (!plainQuote) return null;
  for (const line of pkmSourceLineSpans(source, range.start, range.end)) {
    if (plainLine(source.slice(line.start, line.end)) === plainQuote) return line;
  }
  return null;
}

export function computePkmLineCoverage(params: {
  source: string;
  spans: readonly PkmCoverageSpan[];
  destinations: ReadonlyMap<string, PkmCoverageDestination>;
}): PkmLineCoverage {
  const { source } = params;
  const rank = new Uint8Array(source.length);
  const notMemoryReason: Array<PkmCoverageNotMemoryReason | undefined> = new Array(source.length);
  const heldReason: Array<PkmCoverageHeldReason | undefined> = new Array(source.length);
  for (const span of params.spans) {
    const value = RANK[span.kind];
    for (let index = Math.max(0, span.start); index < Math.min(source.length, span.end); index += 1) {
      if (span.kind === "not_memory") notMemoryReason[index] ??= span.reason;
      if (span.kind === "held") heldReason[index] ??= span.reason;
      if (value > rank[index]!) rank[index] = value;
    }
  }

  const totals = { lines: 0, saved: 0, not_memory: 0, structure: 0, held: 0, not_yet_saved: 0 };
  const lines: PkmCoverageLine[] = [];
  pkmSourceLineSpans(source).forEach((span, lineIndex) => {
    const text = source.slice(span.start, span.end);
    if (!text.trim()) return;
    totals.lines += 1;
    let lowest: number = RANK.committed;
    let anyCommitted = false;
    let firstGap = -1;
    let contentCount = 0;
    for (let index = span.start; index < span.end; index += 1) {
      if (!CONTENT_CHARACTER.test(source[index]!)) continue;
      contentCount += 1;
      const value = rank[index]!;
      if (value === RANK.committed) anyCommitted = true;
      if (value < RANK.not_memory && firstGap === -1) firstGap = index;
      lowest = Math.min(lowest, value);
    }
    const destinations = [...new Set(
      params.spans
        .filter((candidate) => candidate.kind === "committed" && candidate.start < span.end && candidate.end > span.start)
        .map((candidate) => (candidate as { cardId: string }).cardId),
    )]
      .map((cardId) => params.destinations.get(cardId))
      .filter((destination): destination is PkmCoverageDestination => Boolean(destination));
    const entry = (status: PkmCoverageLineStatus, reason?: PkmCoverageReason): PkmCoverageLine => ({
      line: lineIndex + 1, start: span.start, end: span.end, status,
      ...(reason ? { reason } : {}), destinations,
    });
    let line: PkmCoverageLine;
    if (contentCount === 0) line = entry("structure", "formatting");
    else if (lowest >= RANK.not_memory) {
      line = anyCommitted
        ? entry("saved")
        : entry("not_memory", notMemoryReason.slice(span.start, span.end).find(Boolean));
    } else if (isPkmSourceHeadingLine(text)) line = entry("structure", "heading");
    else if (lowest === RANK.held) line = entry("held", heldReason[firstGap]);
    else line = entry("not_yet_saved");
    totals[line.status] += 1;
    lines.push(line);
  });
  return {
    lines,
    totals,
    accounted: totals.saved + totals.not_memory + totals.structure,
  };
}
