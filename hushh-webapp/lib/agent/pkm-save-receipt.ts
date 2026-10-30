/**
 * The receipt of one explicit memory save, and every sentence derived from it.
 *
 * Pure: type-only imports, no network, no vault. The chat card, the status
 * line and the next-turn line for One all read this module, so what the
 * person sees and what One is told are the same counts, and every count comes
 * from preparation coverage or a server-acknowledged commit.
 */

import type { AgentPkmPreviewCard, AgentPkmSaveResult } from "@/lib/agent/agent-pkm-memory";
import { humanizeMemorySegment } from "@/lib/pkm/humanize-segment";
import { toReservedOfferItem, type ReservedOfferItem } from "@/lib/pkm/reserved-offer";
import { toPlainMemoryText } from "@/lib/pkm/memory-plain-text";
import type { PkmNaturalLanguageSourceCoverage } from "@/lib/pkm/pkm-natural-language-ingestion";
import type {
  PkmCoverageLineStatus,
  PkmCoverageReason,
  PkmLineCoverage,
} from "@/lib/pkm/pkm-save-coverage";
import type { PkmSaveJobState } from "@/lib/pkm/pkm-save-job";
import type { PkmMergeOutcome } from "@/lib/pkm/pkm-supersede-merge";

/** A save counts only when the server acknowledged a committed revision. */
export function isCommittedPkmSave(
  result: AgentPkmSaveResult["results"][number] | undefined,
): boolean {
  return Boolean(
    result?.success &&
      result.result?.success &&
      typeof result.result.dataVersion === "number" &&
      Number.isFinite(result.result.dataVersion),
  );
}

export type PkmSaveReceiptItemOutcome = PkmMergeOutcome | "needs_owner" | "failed";

export type PkmSaveReceiptItem = {
  id: string;
  domainLabel: string;
  /** The owner's own words for the detail. Session memory only; never logged. */
  text: string;
  outcome: PkmSaveReceiptItemOutcome;
};

export type PkmSaveReceiptDomain = {
  domain: string;
  label: string;
  saved: number;
  updated: number;
  merged: number;
  unchanged: number;
};

export type PkmSaveReceiptCoverageLine = {
  /** 1-based line number in the owner's text. */
  line: number;
  /** The owner's own line, for display. Session memory only; never logged. */
  text: string;
  status: PkmCoverageLineStatus;
  reason?: PkmCoverageReason;
  /** Where the line was saved: category, path and the server's commit id. */
  savedTo: Array<{ domainLabel: string; path: string | null; commitId: string | null }>;
  /** Details on this line still waiting for the owner's OK. */
  heldCardIds?: string[];
};

/** Line-by-line account of a resumable save job (lib/pkm/pkm-save-job.ts). */
export type PkmSaveReceiptCoverage = {
  jobId: string;
  jobState: PkmSaveJobState;
  totalLines: number;
  /** Saved, not memory, or a heading: nothing left to do for these lines. */
  accountedLines: number;
  savedLines: number;
  notMemoryLines: number;
  structureLines: number;
  heldLines: number;
  notYetSavedLines: number;
  lines: PkmSaveReceiptCoverageLine[];
};

export type PkmSaveReceipt = {
  saved: number;
  updated: number;
  merged: number;
  /** Already in Memory: nothing new was stated. */
  unchanged: number;
  /** Sections or statements the agents judged not to be facts (disclaimers, unknowns). */
  skipped: number;
  /** Credentials and reserved information are deliberately never written. */
  excluded: number;
  /** Proposed details from degraded previews are not safe to write. */
  unreadable: number;
  needsOwner: number;
  failed: number;
  /** Source sections that could not be prepared (timeout or provider failure). */
  unprepared: number;
  domains: PkmSaveReceiptDomain[];
  items: PkmSaveReceiptItem[];
  /**
   * Facts that belong to an app's own screen (reserved-branches.v1.json), each
   * an offer to commit it there. Kept in the branch's agent_memory sibling when
   * saved; offered either way.
   */
  offers: ReservedOfferItem[];
  /** Present when the save ran as a resumable job; see PkmSaveReceiptCoverage. */
  coverage?: PkmSaveReceiptCoverage;
};

export type ExplicitSavePartition = {
  save: AgentPkmPreviewCard[];
  needsOwner: AgentPkmPreviewCard[];
  /** The merge agent matched an existing detail and chose no_op: already known. */
  known: AgentPkmPreviewCard[];
  /** From a section whose preparation degraded (timeout, fallback): never saved, never "skipped". */
  unreadable: AgentPkmPreviewCard[];
  skipped: AgentPkmPreviewCard[];
  excluded: AgentPkmPreviewCard[];
};

function cardDomain(card: AgentPkmPreviewCard): string {
  const decision = card.structure_decision as { target_domain?: unknown } | undefined;
  return String(card.manifest_draft?.domain || decision?.target_domain || card.target_domain || "").trim();
}

function domainLabel(domain: string, titles: ReadonlyMap<string, string>): string {
  return titles.get(domain)?.trim() || humanizeMemorySegment(domain || "memory");
}

function itemText(card: AgentPkmPreviewCard): string {
  const text = String(card.source_text || "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text;
}

/** The owner's line without its Markdown markers (`#`, `- `, `**`); the words are unchanged. */
function lineText(text: string): string {
  const line = toPlainMemoryText(text).replace(/\s+/g, " ").trim();
  return line.length > 240 ? `${line.slice(0, 239).trimEnd()}…` : line;
}

function pathLabel(path: string | null): string | null {
  const segments = String(path || "").split(".").map((segment) => segment.trim()).filter(Boolean);
  return segments.length ? segments.map((segment) => humanizeMemorySegment(segment)).join(" > ") : null;
}

function receiptCoverage(
  params: NonNullable<Parameters<typeof buildPkmSaveReceipt>[0]["lineCoverage"]>,
  titles: ReadonlyMap<string, string>,
): PkmSaveReceiptCoverage {
  const { coverage } = params;
  return {
    jobId: params.jobId,
    jobState: params.jobState,
    totalLines: coverage.totals.lines,
    accountedLines: coverage.accounted,
    savedLines: coverage.totals.saved,
    notMemoryLines: coverage.totals.not_memory,
    structureLines: coverage.totals.structure,
    heldLines: coverage.totals.held,
    notYetSavedLines: coverage.totals.not_yet_saved,
    lines: coverage.lines.map((line) => {
      const held = params.heldCardIds?.get(line.line);
      return {
        line: line.line,
        text: lineText(params.source.slice(line.start, line.end)),
        status: line.status,
        ...(line.reason ? { reason: line.reason } : {}),
        savedTo: line.destinations.map((destination) => ({
          domainLabel: domainLabel(destination.domain, titles),
          path: pathLabel(destination.path),
          commitId: destination.commitId,
        })),
        ...(held?.length ? { heldCardIds: held } : {}),
      };
    }),
  };
}

export function emptyPkmSaveReceipt(): PkmSaveReceipt {
  return {
    saved: 0, updated: 0, merged: 0, unchanged: 0, skipped: 0, excluded: 0, unreadable: 0,
    needsOwner: 0, failed: 0, unprepared: 0, domains: [], items: [], offers: [],
  };
}

/** Pure: every count is derived from preparation coverage and server acks. */
export function buildPkmSaveReceipt(params: {
  coverage: readonly PkmNaturalLanguageSourceCoverage[];
  partition: ExplicitSavePartition;
  saveResult: AgentPkmSaveResult | null;
  domainTitles?: ReadonlyMap<string, string>;
  /** Line coverage from a resumable save job; `source` is the text it covers. */
  lineCoverage?: {
    jobId: string;
    jobState: PkmSaveJobState;
    source: string;
    coverage: PkmLineCoverage;
    heldCardIds?: ReadonlyMap<number, string[]>;
  };
}): PkmSaveReceipt {
  const titles = params.domainTitles ?? new Map<string, string>();
  const receipt = emptyPkmSaveReceipt();
  const domains = new Map<string, PkmSaveReceiptDomain>();
  const domainEntry = (domain: string) => {
    const existing = domains.get(domain);
    if (existing) return existing;
    const entry = { domain, label: domainLabel(domain, titles), saved: 0, updated: 0, merged: 0, unchanged: 0 };
    domains.set(domain, entry);
    return entry;
  };

  params.partition.save.forEach((card, index) => {
    const result = params.saveResult?.results[index];
    const domain = cardDomain(card);
    if (!isCommittedPkmSave(result)) {
      receipt.failed += 1;
      receipt.items.push({ id: card.card_id, domainLabel: domainLabel(domain, titles), text: itemText(card), outcome: "failed" });
      return;
    }
    const outcome: PkmMergeOutcome = result?.outcome ?? "saved";
    receipt[outcome] += 1;
    domainEntry(domain)[outcome] += 1;
    receipt.items.push({ id: card.card_id, domainLabel: domainLabel(domain, titles), text: itemText(card), outcome });
  });
  for (const card of params.partition.needsOwner) {
    receipt.needsOwner += 1;
    receipt.items.push({
      id: card.card_id, domainLabel: domainLabel(cardDomain(card), titles), text: itemText(card), outcome: "needs_owner",
    });
  }
  receipt.skipped += params.partition.skipped.length;
  receipt.excluded += params.partition.excluded.length;
  receipt.unreadable += params.partition.unreadable.length;
  receipt.unchanged += params.partition.known.length;
  for (const block of params.coverage) {
    receipt.unchanged += block.duplicateCount ?? 0;
    receipt.skipped += block.disclaimerCount ?? 0;
    // A degraded or partially accounted section is unresolved even if it
    // returned some cards that were independently safe to save.
    if (block.preparationIssue || block.disposition === "failed" ||
      block.detectedFactCount !== block.accountedFactCount) {
      receipt.unprepared += 1;
      continue;
    }
    if (block.accountedFactCount > 0) continue;
    if (block.disposition === "intentionally_ignored") receipt.skipped += 1;
  }
  receipt.offers = collectReservedOffers([
    ...params.partition.save.filter((_card, index) => isCommittedPkmSave(params.saveResult?.results[index])),
    ...params.partition.excluded,
  ]);
  receipt.domains = [...domains.values()].sort(
    (left, right) =>
      right.saved + right.updated + right.merged - (left.saved + left.updated + left.merged) ||
      left.label.localeCompare(right.label),
  );
  if (params.lineCoverage) receipt.coverage = receiptCoverage(params.lineCoverage, titles);
  return receipt;
}

/** At most three offers, one per screen and label, in the order they arrived. */
export const MAX_RECEIPT_OFFERS = 3;

export function collectReservedOffers(cards: readonly AgentPkmPreviewCard[]): ReservedOfferItem[] {
  const offers: ReservedOfferItem[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const item = toReservedOfferItem(card.card_id, card.reserved_offer);
    if (!item) continue;
    const key = `${item.routePattern}|${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push(item);
    if (offers.length >= MAX_RECEIPT_OFFERS) break;
  }
  return offers;
}

export function pkmSaveReceiptWrote(receipt: PkmSaveReceipt): number {
  return receipt.saved + receipt.updated + receipt.merged;
}

/** One line for the status row; counts only. */
export function describePkmSaveReceipt(receipt: PkmSaveReceipt): string {
  const parts: string[] = [];
  if (receipt.saved) parts.push(`Saved ${receipt.saved}`);
  if (receipt.updated) parts.push(`updated ${receipt.updated}`);
  if (receipt.merged) parts.push(`merged ${receipt.merged}`);
  if (receipt.unchanged) parts.push(`${receipt.unchanged} already known`);
  if (receipt.skipped) parts.push(`${receipt.skipped} left out as non-facts`);
  if (receipt.excluded) parts.push(`${receipt.excluded} excluded for safety`);
  if (receipt.unreadable) parts.push(`${receipt.unreadable} details from degraded previews not saved`);
  if (receipt.needsOwner) parts.push(`${receipt.needsOwner} need your OK`);
  if (receipt.failed) parts.push(`${receipt.failed} couldn’t save`);
  if (receipt.unprepared) {
    parts.push(`${receipt.unprepared} ${receipt.unprepared === 1 ? "section" : "sections"} incomplete`);
  }
  if (!parts.length) return "Nothing in that message needed saving.";
  const line = parts.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/**
 * What One is told on the next turn. Counts and category names only, from
 * this device's acknowledged writes; never the saved values themselves.
 */
export function formatPkmSaveReceiptForAgent(receipt: PkmSaveReceipt): string {
  const wrote = pkmSaveReceiptWrote(receipt);
  const categories = receipt.domains
    .filter((domain) => domain.saved + domain.updated + domain.merged > 0)
    .map((domain) => domain.label)
    .slice(0, 12);
  const facts = [
    `${receipt.saved} new`,
    `${receipt.updated} updated (earlier values kept in history)`,
    `${receipt.merged} merged into existing details`,
    `${receipt.unchanged} already known`,
    `${receipt.skipped} left out as non-facts`,
    `${receipt.excluded} excluded for safety`,
    `${receipt.unreadable} details from degraded previews not saved`,
    `${receipt.needsOwner} waiting for the person's direct OK`,
    `${receipt.failed} failed`,
    `${receipt.unprepared} sections incomplete`,
  ].join(", ");
  const coverage = receipt.coverage;
  return [
    "LATEST MEMORY SAVE RECEIPT (from the person's device, confirmed by committed revisions):",
    wrote > 0
      ? `Saved to Memory: ${facts}.`
      : `Nothing new was written: ${facts}.`,
    categories.length ? `Categories written: ${categories.join(", ")}.` : "",
    coverage
      ? `Line coverage: ${coverage.accountedLines} of ${coverage.totalLines} lines accounted for, ${coverage.notYetSavedLines} not yet saved, ${coverage.heldLines} held back.`
      : "",
    "Report only these counts. Never claim anything else was saved.",
  ].filter(Boolean).join("\n");
}

/** Lines of the owner's text that still have no home (held back or not yet saved). */
export function pkmSaveReceiptCoverageGaps(receipt: PkmSaveReceipt): number {
  return receipt.coverage ? receipt.coverage.heldLines + receipt.coverage.notYetSavedLines : 0;
}

/** The capture phase an explicit save's receipt resolves to. Counts only. */
export function explicitSaveReceiptPhase(receipt: PkmSaveReceipt): "saved" | "partial" | "failed" | "skipped" {
  const wrote = pkmSaveReceiptWrote(receipt);
  const incomplete = receipt.failed + receipt.unprepared + receipt.unreadable + receipt.excluded +
    receipt.needsOwner + pkmSaveReceiptCoverageGaps(receipt) > 0;
  if (wrote > 0 || receipt.unchanged > 0) return incomplete ? "partial" : "saved";
  return incomplete ? "failed" : "skipped";
}

export type ExplicitPkmSaveProgress =
  | { stage: "reading"; done: number; total: number }
  | { stage: "saving"; total: number };

/** Fold a follow-up confirmation's acks into an existing receipt. */
export function applyOwnerConfirmedSave(
  receipt: PkmSaveReceipt,
  cards: readonly AgentPkmPreviewCard[],
  result: AgentPkmSaveResult,
  domainTitles: ReadonlyMap<string, string> = new Map(),
): PkmSaveReceipt {
  const next: PkmSaveReceipt = {
    ...receipt,
    domains: receipt.domains.map((domain) => ({ ...domain })),
    items: [...receipt.items],
    offers: [...(receipt.offers ?? [])],
  };
  cards.forEach((card, index) => {
    const ack = result.results[index];
    const position = next.items.findIndex((item) => item.id === card.card_id && item.outcome === "needs_owner");
    if (!isCommittedPkmSave(ack)) return;
    const outcome: PkmMergeOutcome = ack?.outcome ?? "saved";
    next.needsOwner = Math.max(0, next.needsOwner - 1);
    next[outcome] += 1;
    const domain = cardDomain(card);
    let entry = next.domains.find((candidate) => candidate.domain === domain);
    if (!entry) {
      entry = { domain, label: domainLabel(domain, domainTitles), saved: 0, updated: 0, merged: 0, unchanged: 0 };
      next.domains.push(entry);
    }
    entry[outcome] += 1;
    if (position >= 0) next.items[position] = { ...next.items[position]!, outcome };
  });
  if (next.coverage) next.coverage = applyOwnerConfirmedCoverage(next.coverage, cards, result, domainTitles);
  return next;
}

/** A held line becomes saved once every detail it was waiting on is committed. */
function applyOwnerConfirmedCoverage(
  coverage: PkmSaveReceiptCoverage,
  cards: readonly AgentPkmPreviewCard[],
  result: AgentPkmSaveResult,
  domainTitles: ReadonlyMap<string, string>,
): PkmSaveReceiptCoverage {
  const committed = new Map<string, PkmSaveReceiptCoverageLine["savedTo"][number]>();
  cards.forEach((card, index) => {
    const ack = result.results[index];
    if (!isCommittedPkmSave(ack)) return;
    committed.set(card.card_id, {
      domainLabel: domainLabel(cardDomain(card), domainTitles),
      path: pathLabel(card.primary_json_path ?? card.retrieval_hints?.path ?? null),
      commitId: ack?.result?.commitId ?? null,
    });
  });
  let moved = 0;
  const lines = coverage.lines.map((line) => {
    const held = line.heldCardIds;
    if (line.status !== "held" || line.reason !== "needs_owner" || !held?.length ||
      !held.every((cardId) => committed.has(cardId))) return line;
    moved += 1;
    const { heldCardIds: _done, reason: _reason, ...rest } = line;
    return { ...rest, status: "saved" as const, savedTo: [...line.savedTo, ...held.map((cardId) => committed.get(cardId)!)] };
  });
  return {
    ...coverage,
    lines,
    savedLines: coverage.savedLines + moved,
    heldLines: coverage.heldLines - moved,
    accountedLines: coverage.accountedLines + moved,
  };
}
