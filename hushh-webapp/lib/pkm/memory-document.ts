/**
 * Renders the owner's living `memory.md` from decrypted PKM.
 *
 * This is a derived view, never an authority: the encrypted PKM domains remain
 * the only source of truth, and every line here is reproducible from them. The
 * renderer is pure and import-safe (no network, no database, no vault access)
 * so it can be unit-tested and so a pod can call it too.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. Honest freshness. A domain that failed to load or decrypt is reported as
 *    `unavailable` with its reason and is still listed in the document. It is
 *    never silently dropped, because a missing section is indistinguishable
 *    from "this person has nothing here" and would make a paid answer read
 *    confident exactly when its inputs are absent.
 * 2. Source revisions. Each section carries the `content_revision` it was built
 *    from, so a later reader can tell whether an answer used current material.
 * 3. Audience-correct exclusion. `self` uses the Memory-screen rule; `agent`
 *    uses the stricter packet rule that also drops regulated identifiers and
 *    raw imported source material. A document that may travel to another person
 *    is always built as `agent`.
 *
 * Determinism matters: sections and rows are ordered, so two builds from the
 * same revisions produce byte-identical markdown and a changed document means
 * changed information.
 */

import { reservedEntryFor } from "@/lib/pkm/reserved-branches";
import {
  shouldSkipPkmAgentContextKey,
  shouldSkipPkmMemoryKey,
  type PkmDomainInsight,
  type PkmMemoryCard,
  type PkmMemorySnapshot,
} from "@/lib/pkm/pkm-memory-cards";

/** Who the rendered document is for. Decides which exclusion rule applies. */
export type MemoryDocumentAudience = "self" | "agent";

export type MemoryDomainFreshnessStatus = "current" | "unavailable";

export interface MemoryDomainFreshness {
  domain: string;
  title: string;
  status: MemoryDomainFreshnessStatus;
  /** `pkm_blobs.content_revision` the section was built from; null when unavailable. */
  contentRevision: number | null;
  /** ISO-8601 of the newest item in the section; null when empty or unavailable. */
  updatedAt: string | null;
  cardCount: number;
  /** Set only when `status` is `unavailable`: why the section could not be built. */
  reason?: string;
}

export interface MemoryDocumentSourceDomain {
  domain: string;
  contentRevision: number | null;
  /** Present when the domain could not be read; the section renders as unavailable. */
  unavailableReason?: string;
}

export interface BuildMemoryDocumentParams {
  snapshot: PkmMemorySnapshot;
  /**
   * Every domain the owner has, including ones that failed to load. A domain
   * absent from this list but present in the snapshot is still rendered; a
   * domain listed here with `unavailableReason` renders as unavailable.
   */
  sources: readonly MemoryDocumentSourceDomain[];
  audience: MemoryDocumentAudience;
  /** When the device built this document. Supplied, not read from the clock, so builds are testable. */
  builtAt: string;
}

export interface MemoryDocument {
  markdown: string;
  freshness: MemoryDomainFreshness[];
  /** Domains withheld by the audience's exclusion rule, so the omission is visible rather than silent. */
  excludedDomains: string[];
  /** True when every listed domain rendered successfully. */
  complete: boolean;
}

const EXCLUDED_NOTE =
  "Withheld from this document by the exclusion rule for its audience.";

function escapeTableCell(value: string): string {
  // Only the characters that would break the row's own structure.
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isoOrNull(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text || null;
}

/** Newest `updatedAt` across the cards, or null when none carries one. */
function newestUpdatedAt(cards: readonly PkmMemoryCard[]): string | null {
  let newest: string | null = null;
  for (const card of cards) {
    const updatedAt = isoOrNull(card.updatedAt);
    if (!updatedAt) continue;
    if (!newest || updatedAt > newest) newest = updatedAt;
  }
  return newest;
}

/**
 * Whether the reserved-branch registry forbids this branch's *values* leaving
 * for a model or another person.
 *
 * `contracts/pkm/reserved-branches.v1.json` is `enforce` and declares
 * `send_to_model` per branch. Anything but `full` means the value may not be
 * reproduced: `wallet` and `secrets` are `label_only`, so is
 * `identity.identity_documents`; `kyc_connector`, `kyc_workflow` and
 * `runtime_secrets` are `never`.
 *
 * This document withholds `label_only` branches entirely rather than rendering
 * their labels. A memory document is bulk material that can travel to another
 * person, and the registry routes those branches out through their own
 * consent path instead — `shareable` is `policy` for wallet and
 * `per_item_grant` for secrets. Labels belong in the agent's live context
 * (`lib/agent/agent-pkm-context-store.ts`), not in a shareable artifact.
 *
 * `shouldSkipPkmAgentContextKey` alone is not sufficient here: it does not
 * cover `wallet` or `identity_documents`, so without this check their values
 * would be rendered into a document built for another person.
 */
function restrictedByReservedRegistry(domain: string, branch: string): boolean {
  const entry = reservedEntryFor(domain, branch);
  return entry ? entry.sendToModel !== "full" : false;
}

function excludeForAudience(
  audience: MemoryDocumentAudience,
  key: string,
  branch = "",
): boolean {
  if (audience !== "agent") return shouldSkipPkmMemoryKey(key);
  return shouldSkipPkmAgentContextKey(key) || restrictedByReservedRegistry(key, branch);
}

/** The card's path below its domain, as the reserved registry expects it. */
function cardBranch(card: PkmMemoryCard): string {
  const segments = card.pathSegments || [];
  // pathSegments start at the domain; the registry matches what follows it.
  return segments.slice(1).map((segment) => String(segment)).join(".");
}

function compareCards(a: PkmMemoryCard, b: PkmMemoryCard): number {
  return a.path.localeCompare(b.path) || a.id.localeCompare(b.id);
}

function renderSectionBody(cards: readonly PkmMemoryCard[]): string[] {
  if (cards.length === 0) return ["_Nothing recorded._"];
  const lines = ["| Detail | Value | Source | Updated |", "| --- | --- | --- | --- |"];
  for (const card of [...cards].sort(compareCards)) {
    lines.push(
      `| ${escapeTableCell(card.title)} | ${escapeTableCell(card.value)} | ` +
        `${escapeTableCell(card.sourceLabel)} | ${escapeTableCell(card.updatedAt || "—")} |`,
    );
  }
  return lines;
}

function renderInsight(insight: PkmDomainInsight | undefined): string[] {
  if (!insight) return [];
  const lines: string[] = [];
  const summary = String(insight.summary || "").trim();
  if (summary) lines.push(summary, "");
  for (const highlight of insight.highlights || []) {
    const text = String(highlight || "").trim();
    if (text) lines.push(`- ${text}`);
  }
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  return lines;
}

/**
 * Build the living memory document.
 *
 * The caller supplies an already-decrypted snapshot: this function never
 * touches the vault. Domains the caller could not decrypt are passed in
 * `sources` with an `unavailableReason` so they appear honestly.
 */
export function buildMemoryDocument(params: BuildMemoryDocumentParams): MemoryDocument {
  const { snapshot, sources, audience, builtAt } = params;

  const insightByDomain = new Map<string, PkmDomainInsight>();
  for (const insight of snapshot.domainInsights || []) {
    insightByDomain.set(insight.domain, insight);
  }

  const cardsByDomain = new Map<string, PkmMemoryCard[]>();
  const titleByDomain = new Map<string, string>();
  const excludedDomains = new Set<string>();

  for (const card of snapshot.cards || []) {
    if (excludeForAudience(audience, card.domain, cardBranch(card))) {
      excludedDomains.add(card.domain);
      continue;
    }
    const bucket = cardsByDomain.get(card.domain);
    if (bucket) bucket.push(card);
    else cardsByDomain.set(card.domain, [card]);
    if (!titleByDomain.has(card.domain)) titleByDomain.set(card.domain, card.domainTitle);
  }

  // Order sections by domain key so the document is stable across builds.
  const domains = [
    ...new Set([
      ...sources.map((source) => source.domain),
      ...cardsByDomain.keys(),
    ]),
  ]
    .filter((domain) => !excludedDomains.has(domain))
    .filter((domain) => !excludeForAudience(audience, domain))
    .sort((a, b) => a.localeCompare(b));

  const sourceByDomain = new Map<string, MemoryDocumentSourceDomain>();
  for (const source of sources) sourceByDomain.set(source.domain, source);

  const freshness: MemoryDomainFreshness[] = [];
  const body: string[] = [];

  for (const domain of domains) {
    const source = sourceByDomain.get(domain);
    const cards = cardsByDomain.get(domain) || [];
    const insight = insightByDomain.get(domain);
    const title = titleByDomain.get(domain) || insight?.title || domain;
    const unavailableReason = String(source?.unavailableReason || "").trim();

    if (unavailableReason) {
      freshness.push({
        domain,
        title,
        status: "unavailable",
        contentRevision: null,
        updatedAt: null,
        cardCount: 0,
        reason: unavailableReason,
      });
      body.push(
        `## ${title}`,
        "",
        `_Unavailable: ${unavailableReason}. This section was not read, so nothing here is current._`,
        "",
      );
      continue;
    }

    const contentRevision =
      typeof source?.contentRevision === "number" ? source.contentRevision : null;
    const updatedAt = newestUpdatedAt(cards);

    freshness.push({
      domain,
      title,
      status: "current",
      contentRevision,
      updatedAt,
      cardCount: cards.length,
    });

    body.push(`## ${title}`, "");
    body.push(
      `_Revision ${contentRevision ?? "unknown"} · updated ${updatedAt || "unknown"}._`,
      "",
    );
    body.push(...renderInsight(insight));
    body.push(...renderSectionBody(cards), "");
  }

  const unavailable = freshness.filter((entry) => entry.status === "unavailable");
  const complete = unavailable.length === 0;

  const header: string[] = [
    "# Memory",
    "",
    `_Built on this device at ${builtAt}._`,
    "",
  ];

  if (!complete) {
    header.push(
      `> **Partial.** ${unavailable.length} of ${freshness.length} sections could not be read, ` +
        "so this document is not a complete picture.",
      "",
    );
  }

  if (excludedDomains.size > 0) {
    header.push(
      `> ${EXCLUDED_NOTE} Withheld: ${[...excludedDomains].sort().join(", ")}.`,
      "",
    );
  }

  const markdown = [...header, ...body].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  return {
    markdown,
    freshness,
    excludedDomains: [...excludedDomains].sort(),
    complete,
  };
}
