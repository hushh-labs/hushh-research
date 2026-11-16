/**
 * Revision-bound PKM projections, specialist disagreement checks, and consent
 * anti-broadening for Shared / Browser execution.
 *
 * Mirrors `consent-protocol/hushh_mcp/services/wiki_memory/projections.py`.
 */

import {
  NON_REQUESTABLE_PROJECTION_STATES,
  WIKI_PROJECTION_STATES,
  WikiRefusedError,
  sha256Hex,
  validateClaimId,
  validateIdempotencyKey,
  validatePageId,
  validateProjectionDomain,
  validateProjectionJsonPath,
  validateProjectionReceiptId,
  type SpecialistDisagreementMetadata,
  type WikiProjectionReceipt,
  type WikiProjectionState,
} from "./contracts";
import { SharedWikiLibrary } from "./library";

export const WIKI_CLAIM_PROJECTION_PROFILE = "wiki_claim_projection_v1" as const;
export const WIKI_CLAIM_PROJECTION_MAX_ITEMS = 64;
export const WIKI_CLAIM_PROJECTION_MAX_ITEM_CHARS = 1_000;
export const WIKI_CLAIM_PROJECTION_MAX_TOTAL_CHARS = 24_000;

const SPECIALIST_AUTHORITIES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ["financial", ["financial", "finance", "plaid", "portfolio", "bank_accounts"]],
  ["identity", ["identity", "kyc", "kyc_identity", "verified_identity"]],
  ["consent", ["consent", "active_grants", "scopes"]],
];

function normalizeScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim().toLowerCase();
}

export function detectSpecialistDisagreement(input: {
  claimStatement: string;
  targetDomain: string;
  jsonPath: string;
  proposedValue?: unknown;
  specialistSnapshot?: Record<string, unknown> | null;
}): SpecialistDisagreementMetadata | null {
  const snapshot = input.specialistSnapshot;
  if (!snapshot || typeof snapshot !== "object") return null;

  const leafKey = (input.jsonPath.split(".").pop() ?? "").trim().toLowerCase();
  const stmtLower = input.claimStatement.trim().toLowerCase();
  const normProposed = normalizeScalar(input.proposedValue);

  for (const [canonicalAuthority, aliases] of SPECIALIST_AUTHORITIES) {
    let branch: Record<string, unknown> | null = null;
    for (const alias of aliases) {
      const candidate = snapshot[alias];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        branch = candidate as Record<string, unknown>;
        break;
      }
    }
    if (!branch) continue;

    for (const [specPath, specVal] of Object.entries(branch)) {
      const normSpecKey = specPath.trim().toLowerCase();
      const keyLeaf = normSpecKey.split(".").pop() ?? "";
      const normSpecVal = normalizeScalar(specVal);
      if (!normSpecVal) continue;

      const sameSlot =
        normSpecKey === input.jsonPath ||
        (Boolean(keyLeaf) && keyLeaf === leafKey);
      if (sameSlot) {
        if (normProposed && normProposed !== normSpecVal) {
          return {
            authority: canonicalAuthority,
            reason: "authoritative_value_mismatch",
            path: `${canonicalAuthority}.${normSpecKey}`.slice(0, 128),
          };
        }
        if (!normProposed && !stmtLower.includes(normSpecVal)) {
          return {
            authority: canonicalAuthority,
            reason: "claim_contradicts_specialist",
            path: `${canonicalAuthority}.${normSpecKey}`.slice(0, 128),
          };
        }
      }
    }
  }
  return null;
}

export function resolveTopLevelProjectionState(
  leafStates: readonly WikiProjectionState[],
): { state: WikiProjectionState; materialized_leaf_count: number } {
  if (leafStates.length === 0) {
    return { state: "empty", materialized_leaf_count: 0 };
  }
  const materializedCount = leafStates.filter(
    (st) => st === "materialized",
  ).length;
  if (materializedCount > 0) {
    return { state: "materialized", materialized_leaf_count: materializedCount };
  }
  const priorityOrder: readonly WikiProjectionState[] = [
    "conflicted",
    "private_candidate",
    "stale",
    "pending",
    "failed",
    "empty",
    "unknown",
  ];
  for (const priority of priorityOrder) {
    if (leafStates.includes(priority)) {
      return { state: priority, materialized_leaf_count: 0 };
    }
  }
  return { state: "empty", materialized_leaf_count: 0 };
}

export class SharedWikiProjectionEngine {
  constructor(private readonly library: SharedWikiLibrary) {}

  async receiptIdForSlot(
    domain: string,
    jsonPath: string,
    claimId: string,
  ): Promise<string> {
    const cleanDomain = validateProjectionDomain(domain);
    const cleanPath = validateProjectionJsonPath(jsonPath);
    const cleanClaim = validateClaimId(claimId);
    const hex = await sha256Hex(
      `${this.library.owner}|proj|${cleanDomain}|${cleanPath}|${cleanClaim}`,
    );
    return `wpr_${hex.slice(0, 16)}`;
  }

  async deriveProjection(
    input: {
      pageId: string;
      claimId: string;
      targetDomain?: string | null;
      jsonPath?: string | null;
      idempotencyKey: string;
      activeRecipientCount?: number;
      ownerConfirmed?: boolean;
      proposedValue?: unknown;
      specialistSnapshot?: Record<string, unknown> | null;
      sourceRevision?: number;
    },
    signal?: AbortSignal,
  ): Promise<WikiProjectionReceipt> {
    validateIdempotencyKey(input.idempotencyKey);
    if (!input.targetDomain || !input.jsonPath) {
      throw new WikiRefusedError("WIKI_PROJECTION_MAPPING_REQUIRED", 400);
    }
    const domain = validateProjectionDomain(input.targetDomain);
    const path = validateProjectionJsonPath(input.jsonPath);
    const pageId = validatePageId(input.pageId);
    const claimId = validateClaimId(input.claimId);
    const activeRecipients = input.activeRecipientCount ?? 0;
    const sourceRevision = input.sourceRevision ?? 1;
    if (
      !Number.isSafeInteger(activeRecipients) ||
      activeRecipients < 0 ||
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 1
    ) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }

    const receiptId = await this.receiptIdForSlot(domain, path, claimId);
    const nowMs = Date.now();
    const tombstones = await this.library.listTombstones(signal);

    let page;
    try {
      page = await this.library.readPage(
        pageId,
        { requireSettled: true },
        signal,
      );
    } catch (error) {
      if (
        error instanceof WikiRefusedError &&
        error.code === "WIKI_BATCH_INCOMPLETE"
      ) {
        return this.library.putProjectionReceipt(
          {
            receipt_id: receiptId,
            domain,
            json_path: path,
            page_id: pageId,
            page_revision: 1,
            claim_id: claimId,
            source_ids: [],
            source_revision: sourceRevision,
            state: "pending",
            exposure_eligibility: false,
            updated_at: nowMs,
          },
          input.idempotencyKey,
          signal,
        );
      }
      throw error;
    }

    const claim = page.claims.find((c) => c.claim_id === claimId);
    if (!claim) {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    if (claim.source_ids.length === 0) {
      throw new WikiRefusedError("WIKI_PROJECTION_UNVERIFIED_SOURCE", 400);
    }

    const reversedTombstones = [...tombstones].reverse();
    const claimTb = reversedTombstones.find(
      (t) => t.target_kind === "claim" && t.target_id === claimId,
    );
    const pageTb = reversedTombstones.find(
      (t) => t.target_kind === "page" && t.target_id === pageId,
    );
    const sourceTb = reversedTombstones.find(
      (t) =>
        t.target_kind === "source" && claim.source_ids.includes(t.target_id),
    );

    const verifiedSources: string[] = [];
    for (const srcId of claim.source_ids) {
      const src = await this.library.getSource(srcId, signal);
      if (src.consent_derived) {
        throw new WikiRefusedError("WIKI_SOURCE_INELIGIBLE", 403);
      }
      verifiedSources.push(src.source_id);
    }

    const effectiveTb = claimTb ?? pageTb ?? sourceTb;
    let disagreement: SpecialistDisagreementMetadata | undefined;
    let state: WikiProjectionState;

    if (
      effectiveTb ||
      claim.status === "retracted" ||
      claim.status === "superseded"
    ) {
      state = "stale";
    } else if (
      claim.status === "uncertain" ||
      page.links.some(
        (e) => e.relation === "contradicts" && e.anchor_claim_id === claimId,
      )
    ) {
      state = "conflicted";
    } else {
      const detected = detectSpecialistDisagreement({
        claimStatement: claim.statement,
        targetDomain: domain,
        jsonPath: path,
        proposedValue: input.proposedValue,
        specialistSnapshot: input.specialistSnapshot,
      });
      if (detected) {
        disagreement = detected;
        state = "conflicted";
      } else if (activeRecipients > 0 && !input.ownerConfirmed) {
        state = "private_candidate";
      } else {
        state = "materialized";
      }
    }

    if (!WIKI_PROJECTION_STATES.includes(state)) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }
    return this.library.putProjectionReceipt(
      {
        receipt_id: receiptId,
        domain,
        json_path: path,
        page_id: pageId,
        page_revision: page.revision,
        claim_id: claimId,
        source_ids: verifiedSources,
        source_revision: sourceRevision,
        state,
        exposure_eligibility: state === "materialized",
        updated_at: nowMs,
        ...(effectiveTb ? { tombstone_id: effectiveTb.tombstone_id } : {}),
        ...(disagreement ? { specialist_disagreement: disagreement } : {}),
      },
      input.idempotencyKey,
      signal,
    );
  }

  async confirmCandidateProjection(
    receiptId: string,
    options: {
      idempotencyKey: string;
      specialistSnapshot?: Record<string, unknown> | null;
    },
    signal?: AbortSignal,
  ): Promise<WikiProjectionReceipt> {
    validateIdempotencyKey(options.idempotencyKey);
    const validatedId = validateProjectionReceiptId(receiptId);
    const existing = await this.library.getProjectionReceipt(validatedId, signal);
    if (
      existing.tombstone_id ||
      existing.state === "stale" ||
      existing.state === "conflicted" ||
      existing.state === "failed"
    ) {
      throw new WikiRefusedError("WIKI_PROJECTION_NOT_CONFIRMABLE", 409);
    }
    return this.deriveProjection(
      {
        pageId: existing.page_id,
        claimId: existing.claim_id,
        targetDomain: existing.domain,
        jsonPath: existing.json_path,
        idempotencyKey: options.idempotencyKey,
        activeRecipientCount: 1,
        ownerConfirmed: true,
        specialistSnapshot: options.specialistSnapshot,
        sourceRevision: existing.source_revision + 1,
      },
      signal,
    );
  }

  async syncPageLifecycle(
    pageId: string,
    options?: { pageMoved?: boolean },
    signal?: AbortSignal,
  ): Promise<WikiProjectionReceipt[]> {
    const validatedPageId = validatePageId(pageId);
    const allReceipts = await this.library.listProjectionReceipts(
      undefined,
      signal,
    );
    const matching = allReceipts.filter((r) => r.page_id === validatedPageId);
    if (matching.length === 0) return [];

    const tombstones = [...(await this.library.listTombstones(signal))].reverse();
    const pageTb = tombstones.find(
      (t) => t.target_kind === "page" && t.target_id === validatedPageId,
    );

    let livePage = null;
    try {
      livePage = await this.library.readPage(
        validatedPageId,
        { requireSettled: true },
        signal,
      );
    } catch (error) {
      if (
        !(
          error instanceof WikiRefusedError &&
          (error.code === "WIKI_NOT_FOUND" ||
            error.code === "WIKI_BATCH_INCOMPLETE")
        )
      ) {
        throw error;
      }
    }

    const nowMs = Date.now();
    const updated: WikiProjectionReceipt[] = [];
    for (const rec of matching) {
      const claimTb = tombstones.find(
        (t) => t.target_kind === "claim" && t.target_id === rec.claim_id,
      );
      const sourceTb = tombstones.find(
        (t) =>
          t.target_kind === "source" && rec.source_ids.includes(t.target_id),
      );
      const liveClaim = livePage?.claims.find(
        (c) => c.claim_id === rec.claim_id,
      );
      const needsStale =
        Boolean(options?.pageMoved) ||
        !livePage ||
        !liveClaim ||
        liveClaim.status === "retracted" ||
        liveClaim.status === "superseded" ||
        Boolean(pageTb) ||
        Boolean(claimTb) ||
        Boolean(sourceTb);
      if (!needsStale) continue;

      const tbObj = claimTb ?? pageTb ?? sourceTb;
      const nextPageRev = Math.max(
        rec.page_revision,
        livePage?.revision ?? rec.page_revision,
      );
      const nextSourceRev = rec.source_revision + 1;
      const saved = await this.library.putProjectionReceipt(
        {
          receipt_id: rec.receipt_id,
          domain: rec.domain,
          json_path: rec.json_path,
          page_id: validatedPageId,
          page_revision: nextPageRev,
          claim_id: rec.claim_id,
          source_ids: rec.source_ids,
          source_revision: nextSourceRev,
          state: "stale",
          exposure_eligibility: false,
          updated_at: nowMs,
          ...((tbObj?.tombstone_id ?? rec.tombstone_id)
            ? { tombstone_id: tbObj?.tombstone_id ?? rec.tombstone_id }
            : {}),
          ...(rec.specialist_disagreement
            ? { specialist_disagreement: rec.specialist_disagreement }
            : {}),
        },
        `stale:${rec.receipt_id}:${nextPageRev}:${nextSourceRev}`,
        signal,
      );
      updated.push(saved);
    }
    return updated;
  }

  async projectionStatesForDomain(
    domain: string,
    signal?: AbortSignal,
  ): Promise<Record<string, WikiProjectionReceipt>> {
    const receipts = await this.library.listProjectionReceipts(domain, signal);
    const byPath: Record<string, WikiProjectionReceipt> = {};
    for (const rec of receipts) {
      const prev = byPath[rec.json_path];
      if (
        !prev ||
        rec.page_revision > prev.page_revision ||
        (rec.page_revision === prev.page_revision &&
          rec.source_revision >= prev.source_revision)
      ) {
        byPath[rec.json_path] = rec;
      }
    }
    return byPath;
  }

  async buildAgentLabClaimPayload(
    domain: string,
    maxItems = WIKI_CLAIM_PROJECTION_MAX_ITEMS,
    signal?: AbortSignal,
  ) {
    const cleanDomain = validateProjectionDomain(domain);
    const cap = Math.max(
      1,
      Math.min(Math.trunc(maxItems), WIKI_CLAIM_PROJECTION_MAX_ITEMS),
    );
    const tombstones = await this.library.listTombstones(signal);
    const deadClaims = new Set(
      tombstones
        .filter((t) => t.target_kind === "claim")
        .map((t) => t.target_id),
    );
    const deadPages = new Set(
      tombstones
        .filter((t) => t.target_kind === "page")
        .map((t) => t.target_id),
    );
    const deadSources = new Set(
      tombstones
        .filter((t) => t.target_kind === "source")
        .map((t) => t.target_id),
    );

    const memories: Array<{
      domain: string;
      entity_id: string;
      entity_scope: string;
      intent_class: string;
      message: string;
      active: boolean;
    }> = [];
    let totalChars = 0;

    for (const summary of await this.library.listPages(undefined, signal)) {
      if (deadPages.has(summary.page_id) || summary.pending_batch_id) continue;
      let page;
      try {
        page = await this.library.readPage(
          summary.page_id,
          { requireSettled: true },
          signal,
        );
      } catch {
        continue;
      }
      for (const claim of page.claims) {
        if (memories.length >= cap) break;
        if (
          claim.status !== "active" ||
          deadClaims.has(claim.claim_id) ||
          claim.source_ids.length === 0 ||
          claim.source_ids.some((s) => deadSources.has(s))
        ) {
          continue;
        }
        const excerpt = claim.statement.slice(
          0,
          WIKI_CLAIM_PROJECTION_MAX_ITEM_CHARS,
        );
        if (totalChars + excerpt.length > WIKI_CLAIM_PROJECTION_MAX_TOTAL_CHARS) {
          break;
        }
        memories.push({
          domain: cleanDomain,
          entity_id: claim.claim_id,
          entity_scope: `${page.page_id}_r${page.revision}`,
          intent_class: "wiki_claim_projection",
          message: excerpt,
          active: true,
        });
        totalChars += excerpt.length;
      }
    }

    return {
      memory_profile: WIKI_CLAIM_PROJECTION_PROFILE,
      target_domain: cleanDomain,
      simulated_state: {
        domains: [cleanDomain],
        memories,
      },
      non_requestable_states: [...NON_REQUESTABLE_PROJECTION_STATES].sort(),
    };
  }
}

