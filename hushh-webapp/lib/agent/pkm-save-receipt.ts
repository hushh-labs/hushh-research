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
import type { PkmNaturalLanguageSourceCoverage } from "@/lib/pkm/pkm-natural-language-ingestion";
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

export function emptyPkmSaveReceipt(): PkmSaveReceipt {
  return {
    saved: 0, updated: 0, merged: 0, unchanged: 0, skipped: 0, excluded: 0, unreadable: 0,
    needsOwner: 0, failed: 0, unprepared: 0, domains: [], items: [],
  };
}

/** Pure: every count is derived from preparation coverage and server acks. */
export function buildPkmSaveReceipt(params: {
  coverage: readonly PkmNaturalLanguageSourceCoverage[];
  partition: ExplicitSavePartition;
  saveResult: AgentPkmSaveResult | null;
  domainTitles?: ReadonlyMap<string, string>;
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
  receipt.domains = [...domains.values()].sort(
    (left, right) =>
      right.saved + right.updated + right.merged - (left.saved + left.updated + left.merged) ||
      left.label.localeCompare(right.label),
  );
  return receipt;
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
  return [
    "LATEST MEMORY SAVE RECEIPT (from the person's device, confirmed by committed revisions):",
    wrote > 0
      ? `Saved to Memory: ${facts}.`
      : `Nothing new was written: ${facts}.`,
    categories.length ? `Categories written: ${categories.join(", ")}.` : "",
    "Report only these counts. Never claim anything else was saved.",
  ].filter(Boolean).join("\n");
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
  return next;
}
