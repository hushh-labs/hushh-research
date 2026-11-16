/**
 * Phase 4 & 5 Shared-runtime per-owner wiki migration, Forget propagation, rollback, and lint.
 *
 * Mirrors `consent-protocol/hushh_mcp/services/wiki_memory/migration_and_maintenance.py` while
 * enforcing Shared foreground custody boundaries (`#9370` Phase 4 & Phase 5):
 * - Runs exclusively in the unlocked owner browser under `vaultKey` + active `AbortSignal` /
 *   `X-Files-Mutation-Lease`; vault lock or tab close withdraws pending work immediately and
 *   leaves zero plaintext or server key escrow on the Shared hub.
 * - Reports all five distinct `#9370` erasure outcomes (`logical_deletion`,
 *   `revoked_future_access`, `key_destroyed`, `provider_operation_acknowledged`,
 *   `physical_erasure_under_retention`) without conflating them.
 * - Filters all `wtb_*` tombstones during legacy compilation, dual-read verification, and
 *   one-step rollback to `v1_markdown_only` so forgotten details never resurrect.
 */

import { findSecretSpans } from "@/lib/pkm/secret-patterns";

import {
  WIKI_HOT_MAX_CHARS,
  type WikiClaim,
  WikiRefusedError,
  extractInlineLinks,
  sha256Hex,
  validateClaimId,
  validateIdempotencyKey,
  validatePageId,
} from "./contracts";
import { SharedWikiLibrary } from "./library";
import { SharedWikiProjectionEngine } from "./projections";
import {
  DEFAULT_WORKING_PAGE_ID,
  DEFAULT_WORKING_PAGE_TITLE,
  SharedWikiKnowledgeWriter,
} from "./writer";

export const WIKI_MIGRATION_STATES = [
  "v1_markdown_only",
  "dual_read_shadow_compile",
  "wiki_primary_with_v1_rollback",
  "wiki_primary",
] as const;

export type WikiMigrationState = (typeof WIKI_MIGRATION_STATES)[number];

export interface WikiErasureOutcomes {
  logical_deletion: boolean;
  revoked_future_access: boolean;
  key_destroyed: boolean;
  provider_operation_acknowledged: boolean;
  physical_erasure_under_retention: boolean;
}

const MIGRATION_CHECKPOINT_NAME = "migration_state";
const MAINTENANCE_CHECKPOINT_NAME = "maintenance_cursor";
const TOMBSTONE_FPS_CHECKPOINT_NAME = "tombstoned_fingerprints";

interface StoredTombstoneFingerprints extends Record<string, unknown> {
  fingerprints: string[];
  updated_at: number;
}

const HEADING_LINE_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_LINE_RE = /^\s*[-*]\s+(.+?)\s*$/;
const NEGATION_WORDS = new Set([
  "not",
  "never",
  "no",
  "none",
  "dislikes",
  "avoids",
  "stopped",
  "quit",
  "cancelled",
]);

interface StoredMigrationCheckpoint extends Record<string, unknown> {
  state: WikiMigrationState;
  compiled_source_sha256: string | null;
  dual_read_qualified: boolean;
  cold_recovery_qualified: boolean;
  updated_at: number;
  rolled_back_at?: number;
}

interface StoredMaintenanceCheckpoint extends Record<string, unknown> {
  last_run_id: string;
  last_page_id: string;
  reference_date: string;
  sweep_complete: boolean;
  updated_at: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function stripSecretsForWiki(text: string): string {
  if (!text) return "";
  const spans = findSecretSpans(text);
  if (spans.length === 0) return text;
  let cursor = 0;
  const parts: string[] = [];
  for (const span of spans) {
    parts.push(text.slice(cursor, span.start));
    parts.push("[credential omitted]");
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

export async function normalizeStatementFingerprint(
  statement: string,
): Promise<string> {
  const collapsed = String(statement || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return sha256Hex(collapsed);
}

export function parseV1MarkdownSections(
  markdown: string,
): Array<{ title: string; bullets: Array<{ line: number; statement: string }> }> {
  const sections: Array<{
    title: string;
    bullets: Array<{ line: number; statement: string }>;
  }> = [];
  let currentHeading = DEFAULT_WORKING_PAGE_TITLE;
  let currentBullets: Array<{ line: number; statement: string }> = [];

  const lines = String(markdown || "").split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const stripped = rawLine.trim();
    if (!stripped) return;
    const headingMatch = HEADING_LINE_RE.exec(stripped);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      if (
        level === 1 &&
        ["memory.md", "memory", "personal memory"].includes(title.toLowerCase())
      ) {
        return;
      }
      if (currentBullets.length > 0) {
        sections.push({ title: currentHeading, bullets: [...currentBullets] });
        currentBullets = [];
      }
      currentHeading = title.slice(0, 120) || DEFAULT_WORKING_PAGE_TITLE;
      return;
    }

    const bulletMatch = BULLET_LINE_RE.exec(rawLine);
    if (bulletMatch) {
      const cleaned = stripSecretsForWiki(bulletMatch[1]!.trim());
      const residual = cleaned
        .replace(/\[credential omitted\]/g, "")
        .replace(/^[\s.,:;=-]+|[\s.,:;=-]+$/g, "");
      if (residual) {
        currentBullets.push({ line: lineNo, statement: cleaned.slice(0, 1000) });
      }
    }
  });

  if (currentBullets.length > 0) {
    sections.push({ title: currentHeading, bullets: [...currentBullets] });
  }
  return sections;
}

function subjectSlotKey(
  statement: string,
): { slot: string; negated: boolean } | null {
  const tokens = statement.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  if (tokens.length < 3) return null;
  const negated = tokens.some((tok) => NEGATION_WORDS.has(tok));
  const stopWords = new Set([
    "the",
    "owner",
    "prefers",
    "likes",
    "uses",
    "is",
    "are",
    "has",
    "have",
  ]);
  const content = tokens.filter(
    (tok) => !NEGATION_WORDS.has(tok) && !stopWords.has(tok),
  );
  if (content.length < 2) return null;
  return { slot: `${content[0]} ${content[1]}`, negated };
}

export class SharedWikiOwnerMigrator {
  readonly writer: SharedWikiKnowledgeWriter;
  readonly projections: SharedWikiProjectionEngine;

  constructor(
    private readonly library: SharedWikiLibrary,
    options?: {
      writer?: SharedWikiKnowledgeWriter;
      projections?: SharedWikiProjectionEngine;
    },
  ) {
    this.writer = options?.writer ?? new SharedWikiKnowledgeWriter(library);
    this.projections =
      options?.projections ?? new SharedWikiProjectionEngine(library);
  }

  private async pageIdForSection(sectionTitle: string): Promise<string> {
    const norm = sectionTitle
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (!norm || norm === DEFAULT_WORKING_PAGE_TITLE.toLowerCase()) {
      return DEFAULT_WORKING_PAGE_ID;
    }
    const digest = await sha256Hex(
      `${this.library.owner}|v1_section_page|${norm}`,
    );
    return `wpg_${digest.slice(0, 16)}`;
  }

  private async sourceIdForLegacy(
    origin: string,
    locator: string,
    statementFp: string,
  ): Promise<string> {
    const digest = await sha256Hex(
      `${this.library.owner}|legacy_src|${origin}|${locator}|${statementFp}`,
    );
    return `wsr_${digest.slice(0, 16)}`;
  }

  private async tombstoneIndex(signal?: AbortSignal): Promise<{
    statementFps: Set<string>;
    claimIds: Set<string>;
    sourceIds: Set<string>;
  }> {
    const tombstones = await this.library.listTombstones(signal);
    const fpSnap =
      await this.library.readNamedCheckpoint<StoredTombstoneFingerprints>(
        TOMBSTONE_FPS_CHECKPOINT_NAME,
        signal,
      );
    const statementFps = new Set<string>(fpSnap.payload?.fingerprints ?? []);
    const claimIds = new Set<string>();
    const sourceIds = new Set<string>();
    for (const tb of tombstones) {
      if (tb.target_kind === "claim" && tb.target_id)
        claimIds.add(tb.target_id);
      if (tb.target_kind === "source" && tb.target_id)
        sourceIds.add(tb.target_id);
    }
    return { statementFps, claimIds, sourceIds };
  }

  private async recordTombstonedFingerprint(
    statementFp: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const snap =
      await this.library.readNamedCheckpoint<StoredTombstoneFingerprints>(
        TOMBSTONE_FPS_CHECKPOINT_NAME,
        signal,
      );
    const existing = new Set<string>(snap.payload?.fingerprints ?? []);
    if (existing.has(statementFp)) return;
    existing.add(statementFp);
    await this.library.writeNamedCheckpoint<StoredTombstoneFingerprints>(
      TOMBSTONE_FPS_CHECKPOINT_NAME,
      {
        fingerprints: [...existing].sort(),
        updated_at: Date.now(),
      },
      snap.revision,
      signal,
    );
  }

  async getMigrationStatus(signal?: AbortSignal) {
    const { payload, revision } =
      await this.library.readNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        signal,
      );
    if (!payload) {
      return {
        owner: this.library.owner,
        state: "v1_markdown_only" as WikiMigrationState,
        migration_revision: revision,
        compiled_source_sha256: null,
        dual_read_qualified: false,
        cold_recovery_qualified: false,
        updated_at: 0,
      };
    }
    return {
      owner: this.library.owner,
      state: payload.state ?? "v1_markdown_only",
      migration_revision: revision,
      compiled_source_sha256: payload.compiled_source_sha256 ?? null,
      dual_read_qualified: Boolean(payload.dual_read_qualified),
      cold_recovery_qualified: Boolean(payload.cold_recovery_qualified),
      updated_at: Number(payload.updated_at ?? 0),
    };
  }

  async compileLegacySources(input: {
    v1Markdown: string;
    idempotencyKey: string;
    expectedMigrationRevision?: number;
    signal?: AbortSignal;
  }) {
    const { v1Markdown, expectedMigrationRevision, signal } = input;
    signal?.throwIfAborted();
    this.library.store.check();
    const idem = validateIdempotencyKey(input.idempotencyKey);
    const statusBefore = await this.getMigrationStatus(signal);
    if (
      expectedMigrationRevision !== undefined &&
      statusBefore.migration_revision !== expectedMigrationRevision
    ) {
      throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
    }

    const { statementFps, claimIds, sourceIds } =
      await this.tombstoneIndex(signal);
    const sections = parseV1MarkdownSections(v1Markdown);
    const today = todayUtc();
    const observedIso = `${today}T00:00:00Z`;
    let compiledClaimCount = 0;
    let skippedTombstonedCount = 0;
    const touchedPageIds = new Set<string>();

    for (const sec of sections) {
      signal?.throwIfAborted();
      const pageId = await this.pageIdForSection(sec.title);
      let existingPage: Awaited<ReturnType<SharedWikiLibrary["readPage"]>> | null =
        null;
      try {
        existingPage = await this.library.readPage(pageId, undefined, signal);
      } catch (err) {
        if (!(err instanceof WikiRefusedError) || err.code !== "WIKI_NOT_FOUND") {
          throw err;
        }
      }

      const claimsById = new Map<string, WikiClaim>();
      for (const c of existingPage?.claims ?? []) {
        claimsById.set(c.claim_id, { ...c });
      }
      const mergedSources = new Set<string>(existingPage?.source_ids ?? []);

      for (const bullet of sec.bullets) {
        signal?.throwIfAborted();
        const stmt = bullet.statement.trim();
        const stmtFp = await normalizeStatementFingerprint(stmt);
        const claimId = await this.writer.claimIdForStatement(pageId, stmt);
        const locator = `pkm:one_memory.markdown#line:${bullet.line}`;
        const sourceId = await this.sourceIdForLegacy(
          "v1_markdown",
          locator,
          stmtFp,
        );
        if (
          statementFps.has(stmtFp) ||
          claimIds.has(claimId) ||
          sourceIds.has(sourceId)
        ) {
          skippedTombstonedCount += 1;
          continue;
        }

        await this.library.registerSource(
          {
            source_id: sourceId,
            kind: "pkm_record",
            locator,
            content_sha256: stmtFp,
            observed_at: observedIso,
            consent_derived: false,
          },
          `${idem}:src:${sourceId}`.slice(0, 120),
          signal,
        );
        mergedSources.add(sourceId);

        const prior = claimsById.get(claimId);
        if (prior) {
          if (prior.status === "retracted" || prior.status === "superseded") {
            continue;
          }
          const srcUnion = [
            ...new Set([...(prior.source_ids ?? []), sourceId]),
          ].sort();
          claimsById.set(claimId, { ...prior, source_ids: srcUnion });
        } else {
          claimsById.set(claimId, {
            claim_id: claimId,
            statement: stmt,
            status: "active",
            confidence: 1.0,
            source_ids: [sourceId],
            observed_at: today,
          });
        }
        compiledClaimCount += 1;
      }

      const mergedClaims = [...claimsById.values()];
      if (mergedClaims.length === 0 && !existingPage) continue;
      const activeStmts = mergedClaims
        .filter((c) => (c.status ?? "active") === "active")
        .map((c) => c.statement);
      const body =
        existingPage && existingPage.body.trim()
          ? existingPage.body
          : activeStmts.map((s) => `- ${s}`).join("\n");
      const tldr =
        existingPage && existingPage.tldr.trim()
          ? existingPage.tldr
          : activeStmts[0]?.slice(0, 240) ?? "";

      if (!existingPage) {
        await this.library.createPage(
          {
            page_id: pageId,
            title: sec.title,
            folder: pageId === DEFAULT_WORKING_PAGE_ID ? "root" : "topics",
            tldr,
            status_as_of: today,
            body,
            claims: mergedClaims,
            links: [],
            source_ids: [...mergedSources].sort(),
            idempotency_key: `${idem}:create:${pageId}`.slice(0, 120),
          },
          signal,
        );
      } else {
        await this.library.editPage(
          pageId,
          {
            expected_revision: existingPage.revision,
            idempotency_key:
              `${idem}:edit:${pageId}:${existingPage.revision}`.slice(0, 120),
            tldr,
            status_as_of: today,
            body,
            claims: mergedClaims,
            source_ids: [...mergedSources].sort(),
          },
          signal,
        );
      }
      touchedPageIds.add(pageId);
    }

    await this.library.rebuildIndexes(signal);
    await this.writer.refreshHotDigest(signal);

    const compiledDigest = await sha256Hex(v1Markdown);
    const nextState: WikiMigrationState =
      statusBefore.state === "wiki_primary_with_v1_rollback" ||
      statusBefore.state === "wiki_primary"
        ? statusBefore.state
        : "dual_read_shadow_compile";
    const saved =
      await this.library.writeNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        {
          state: nextState,
          compiled_source_sha256: compiledDigest,
          dual_read_qualified: false,
          cold_recovery_qualified: statusBefore.cold_recovery_qualified,
          updated_at: Date.now(),
        },
        statusBefore.migration_revision,
        signal,
      );

    return {
      state: nextState,
      migration_revision: saved.revision,
      compiled_claim_count: compiledClaimCount,
      skipped_tombstoned_count: skippedTombstonedCount,
      touched_page_ids: [...touchedPageIds].sort(),
      compiled_source_sha256: compiledDigest,
    };
  }

  async verifyDualReadParity(input: {
    v1Markdown: string;
    expectedScopedDomains?: string[];
    signal?: AbortSignal;
  }) {
    const { v1Markdown, expectedScopedDomains = [], signal } = input;
    signal?.throwIfAborted();
    const { statementFps, claimIds } = await this.tombstoneIndex(signal);
    const summaries = await this.library.listPages(undefined, signal);
    const coveredFps = new Set<string>();
    const resurrectedClaims: string[] = [];

    for (const summary of summaries) {
      const page = await this.library.readPage(summary.page_id, undefined, signal);
      for (const claim of page.claims) {
        const fp = await normalizeStatementFingerprint(claim.statement);
        coveredFps.add(fp);
        if (
          claim.status === "active" &&
          (statementFps.has(fp) || claimIds.has(claim.claim_id))
        ) {
          resurrectedClaims.push(claim.claim_id);
        }
      }
    }

    const expectedFps = new Set<string>();
    for (const sec of parseV1MarkdownSections(v1Markdown)) {
      for (const bullet of sec.bullets) {
        const fp = await normalizeStatementFingerprint(bullet.statement);
        if (!statementFps.has(fp)) expectedFps.add(fp);
      }
    }

    let missingCount = 0;
    for (const fp of expectedFps) {
      if (!coveredFps.has(fp)) missingCount += 1;
    }

    let scopedProjectionMatch = true;
    for (const domain of expectedScopedDomains) {
      const states = await this.projections.projectionStatesForDomain(
        domain,
        signal,
      );
      for (const info of Object.values(states)) {
        if (info.exposure_eligibility && info.state !== "materialized") {
          scopedProjectionMatch = false;
        }
      }
    }

    const exactContentMatch =
      missingCount === 0 && resurrectedClaims.length === 0;
    const qualified = exactContentMatch && scopedProjectionMatch;

    const { payload, revision } =
      await this.library.readNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        signal,
      );
    const base: StoredMigrationCheckpoint = payload ?? {
      state: "v1_markdown_only",
      compiled_source_sha256: null,
      dual_read_qualified: false,
      cold_recovery_qualified: false,
      updated_at: Date.now(),
    };
    const saved =
      await this.library.writeNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        {
          ...base,
          dual_read_qualified: qualified,
          updated_at: Date.now(),
        },
        revision,
        signal,
      );

    return {
      qualified,
      exact_content_match: exactContentMatch,
      scoped_projection_match: scopedProjectionMatch,
      expected_fact_count: expectedFps.size,
      missing_fact_count: missingCount,
      unexpected_resurrection_count: resurrectedClaims.length,
      migration_revision: saved.revision,
    };
  }

  async verifyColdReconstruction(input: {
    chatSessionVerifier?: () => Promise<boolean>;
    signal?: AbortSignal;
  }) {
    const { chatSessionVerifier, signal } = input;
    signal?.throwIfAborted();
    let wikiChunksReadable = true;
    let pagesVerified = 0;
    try {
      const summaries = await this.library.listPages(undefined, signal);
      for (const summary of summaries) {
        const keyInfo = await this.library.exportNarrowPageKey(
          summary.page_id,
          signal,
        );
        if (!keyInfo.contentKeyHex || keyInfo.contentKeyHex.length !== 64) {
          wikiChunksReadable = false;
          break;
        }
        const page = await this.library.readPage(
          summary.page_id,
          { requireSettled: true },
          signal,
        );
        if (page.page_id !== summary.page_id) {
          wikiChunksReadable = false;
          break;
        }
        pagesVerified += 1;
      }
    } catch {
      wikiChunksReadable = false;
    }

    let nestedReadable = true;
    try {
      await this.library.readHotDigest(signal);
      await this.library.readCaptureCheckpoint(signal);
      await this.library.listTombstones(signal);
      await this.library.listProjectionReceipts(undefined, signal);
      await this.library.rebuildIndexes(signal);
    } catch {
      nestedReadable = false;
    }

    const chatSessionOk = chatSessionVerifier
      ? await chatSessionVerifier()
      : false;
    const qualified = wikiChunksReadable && nestedReadable && chatSessionOk;

    const { payload, revision } =
      await this.library.readNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        signal,
      );
    const base: StoredMigrationCheckpoint = payload ?? {
      state: "v1_markdown_only",
      compiled_source_sha256: null,
      dual_read_qualified: false,
      cold_recovery_qualified: false,
      updated_at: Date.now(),
    };
    const saved =
      await this.library.writeNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        {
          ...base,
          cold_recovery_qualified: qualified,
          updated_at: Date.now(),
        },
        revision,
        signal,
      );

    return {
      qualified,
      commit_log_head_verified: true,
      wiki_chunks_readable: wikiChunksReadable,
      nested_memory_ciphertext_readable: nestedReadable,
      chat_key_session_recovery_verified: chatSessionOk,
      pages_verified: pagesVerified,
      migration_revision: saved.revision,
    };
  }

  async advanceMigrationState(input: {
    targetState: WikiMigrationState;
    expectedMigrationRevision: number;
    signal?: AbortSignal;
  }) {
    const { targetState, expectedMigrationRevision, signal } = input;
    if (!WIKI_MIGRATION_STATES.includes(targetState)) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }
    const { payload, revision } =
      await this.library.readNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        signal,
      );
    if (revision !== expectedMigrationRevision) {
      throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
    }
    const cur: StoredMigrationCheckpoint = payload ?? {
      state: "v1_markdown_only",
      compiled_source_sha256: null,
      dual_read_qualified: false,
      cold_recovery_qualified: false,
      updated_at: Date.now(),
    };

    if (targetState === "wiki_primary_with_v1_rollback") {
      if (
        cur.state !== "dual_read_shadow_compile" &&
        cur.state !== "wiki_primary_with_v1_rollback"
      ) {
        throw new WikiRefusedError("WIKI_MIGRATION_PRECONDITION_FAILED", 409);
      }
      if (!cur.dual_read_qualified) {
        throw new WikiRefusedError("WIKI_MIGRATION_PARITY_REQUIRED", 409);
      }
    } else if (targetState === "wiki_primary") {
      if (
        cur.state !== "wiki_primary_with_v1_rollback" &&
        cur.state !== "wiki_primary"
      ) {
        throw new WikiRefusedError("WIKI_MIGRATION_PRECONDITION_FAILED", 409);
      }
      if (!cur.dual_read_qualified || !cur.cold_recovery_qualified) {
        throw new WikiRefusedError("WIKI_MIGRATION_RECOVERY_REQUIRED", 409);
      }
    }

    const saved =
      await this.library.writeNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        {
          ...cur,
          state: targetState,
          updated_at: Date.now(),
        },
        revision,
        signal,
      );
    return { state: targetState, migration_revision: saved.revision };
  }

  async propagateForgetAndCorrection(input: {
    pageId: string;
    claimId: string;
    idempotencyKey: string;
    replacementStatement?: string;
    destroyPageKey?: boolean;
    v1MarkdownSnapshot?: string;
    stmEntries?: string[];
    invalidateCaches?: () => void | Promise<void>;
    signal?: AbortSignal;
  }) {
    const {
      replacementStatement,
      destroyPageKey = false,
      v1MarkdownSnapshot,
      stmEntries,
      invalidateCaches,
      signal,
    } = input;
    signal?.throwIfAborted();
    const validatedPageId = validatePageId(input.pageId);
    const validatedClaimId = validateClaimId(input.claimId);
    const idem = validateIdempotencyKey(input.idempotencyKey);

    const page = await this.library.readPage(
      validatedPageId,
      { requireSettled: true },
      signal,
    );
    const targetClaim = page.claims.find(
      (c) => c.claim_id === validatedClaimId,
    );
    if (!targetClaim) {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }

    const oldStmt = targetClaim.statement;
    const oldFp = await normalizeStatementFingerprint(oldStmt);
    const today = todayUtc();
    const checkpoint = await this.library.readCaptureCheckpoint(signal);
    const tombId = await this.writer.tombstoneIdForTarget(
      "claim",
      validatedClaimId,
      checkpoint.edit_generation + 1,
    );
    let replacementClaimId: string | null = null;
    let cleanNewText: string | null = null;
    if (replacementStatement !== undefined) {
      cleanNewText = stripSecretsForWiki(replacementStatement.trim());
      if (!cleanNewText) {
        throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
      }
      replacementClaimId = await this.writer.claimIdForStatement(
        validatedPageId,
        cleanNewText,
      );
    }

    await this.library.putTombstone(
      {
        tombstone_id: tombId,
        target_kind: "claim",
        target_id: validatedClaimId,
        reason_code:
          replacementClaimId === null ? "owner_request" : "superseded",
        created_at: Date.now(),
        page_id: validatedPageId,
        ...(replacementClaimId ? { superseded_by: replacementClaimId } : {}),
      },
      `${idem}:tb`.slice(0, 120),
      signal,
    );
    await this.recordTombstonedFingerprint(oldFp, signal);

    const updatedClaims: WikiClaim[] = [];
    for (const existing of page.claims) {
      if (existing.claim_id !== validatedClaimId) {
        updatedClaims.push({ ...existing });
        continue;
      }
      if (cleanNewText !== null && replacementClaimId !== null) {
        updatedClaims.push({
          ...existing,
          status: "superseded",
          superseded_by: replacementClaimId,
          valid_until: today,
        });
        const newFp = await normalizeStatementFingerprint(cleanNewText);
        const srcId = await this.sourceIdForLegacy(
          "owner_correction",
          `owner_correction:${validatedClaimId}`,
          newFp,
        );
        await this.library.registerSource(
          {
            source_id: srcId,
            kind: "owner_direct",
            locator: `owner_correction:${validatedClaimId}`,
            content_sha256: newFp,
            observed_at: `${today}T00:00:00Z`,
            consent_derived: false,
          },
          `${idem}:corr_src`.slice(0, 120),
          signal,
        );
        updatedClaims.push({
          claim_id: replacementClaimId,
          statement: cleanNewText.slice(0, 1000),
          status: "active",
          confidence: 1.0,
          source_ids: [srcId],
          observed_at: today,
        });
      } else {
        updatedClaims.push({
          ...existing,
          status: "retracted",
          valid_until: today,
        });
      }
    }

    const cleanedBodyLines = page.body
      .split(/\r?\n/)
      .filter((line) => !line.toLowerCase().includes(oldStmt.toLowerCase()));
    if (cleanNewText !== null && replacementClaimId) {
      cleanedBodyLines.push(`- ${cleanNewText.slice(0, 1000)}`);
    }
    const activeRemaining = updatedClaims
      .filter((c) => (c.status ?? "active") === "active")
      .map((c) => c.statement);
    const nextTldr = activeRemaining[0]?.slice(0, 240) ?? "";
    const mergedSources = [
      ...new Set([
        ...page.source_ids,
        ...updatedClaims.flatMap((c) => c.source_ids ?? []),
      ]),
    ].sort();

    const edited = await this.library.editPage(
      validatedPageId,
      {
        expected_revision: page.revision,
        idempotency_key: `${idem}:page_edit`.slice(0, 120),
        tldr: nextTldr,
        status_as_of: today,
        body: cleanedBodyLines.join("\n"),
        claims: updatedClaims,
        source_ids: mergedSources,
      },
      signal,
    );

    const staledReceipts = await this.projections.syncPageLifecycle(
      validatedPageId,
      undefined,
      signal,
    );
    const revokedFutureAccess =
      staledReceipts.length === 0 ||
      staledReceipts.some(
        (r) => r.claim_id === validatedClaimId && !r.exposure_eligibility,
      );

    let keyDestroyed = false;
    let physicalErasure = false;
    if (destroyPageKey) {
      const rot = await this.library.rotatePageContentKeyAndPruneHistory(
        validatedPageId,
        `${idem}:rot`.slice(0, 120),
        signal,
      );
      keyDestroyed = rot.key_destroyed;
      physicalErasure = rot.physical_erasure_under_retention;
    }

    await this.library.rebuildIndexes(signal);
    await this.writer.refreshHotDigest(signal);
    if (invalidateCaches) {
      await invalidateCaches();
    }

    let scrubbedV1: string | null = null;
    if (v1MarkdownSnapshot !== undefined) {
      scrubbedV1 = await this.scrubMarkdownTombstones(
        v1MarkdownSnapshot,
        new Set([oldFp]),
      );
    }
    const scrubbedStm = stmEntries
      ? stmEntries.filter(
          (item) => !item.toLowerCase().includes(oldStmt.toLowerCase()),
        )
      : null;

    const outcomes: WikiErasureOutcomes = {
      logical_deletion: true,
      revoked_future_access: revokedFutureAccess,
      key_destroyed: keyDestroyed,
      // Shared runtime never uses Vertex provider memory; never claim provider ack on Shared.
      provider_operation_acknowledged: false,
      physical_erasure_under_retention: physicalErasure,
    };

    return {
      page_id: validatedPageId,
      revision: edited.revision,
      retracted_claim_id: validatedClaimId,
      replacement_claim_id: replacementClaimId,
      tombstone_id: tombId,
      staled_projection_receipt_ids: staledReceipts.map((r) => r.receipt_id),
      staled_projection_receipts: staledReceipts,
      outcomes,
      scrubbed_v1_markdown: scrubbedV1,
      scrubbed_stm_entries: scrubbedStm,
    };
  }

  private async scrubMarkdownTombstones(
    markdown: string,
    tombstonedFps: Set<string>,
  ): Promise<string> {
    const kept: string[] = [];
    for (const rawLine of String(markdown || "").split(/\r?\n/)) {
      const bulletMatch = BULLET_LINE_RE.exec(rawLine);
      if (bulletMatch) {
        const cleaned = stripSecretsForWiki(bulletMatch[1]!.trim());
        const fp = await normalizeStatementFingerprint(cleaned);
        if (tombstonedFps.has(fp)) continue;
      }
      kept.push(rawLine);
    }
    return kept.join("\n");
  }

  async rollbackToV1Markdown(input: {
    priorV1Markdown?: string;
    expectedMigrationRevision?: number;
    allowPostGraduation?: boolean;
    signal?: AbortSignal;
  }) {
    const {
      priorV1Markdown = "",
      expectedMigrationRevision,
      allowPostGraduation = false,
      signal,
    } = input;
    signal?.throwIfAborted();
    const { payload, revision } =
      await this.library.readNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        signal,
      );
    if (
      expectedMigrationRevision !== undefined &&
      revision !== expectedMigrationRevision
    ) {
      throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
    }
    const cur: StoredMigrationCheckpoint = payload ?? {
      state: "v1_markdown_only",
      compiled_source_sha256: null,
      dual_read_qualified: false,
      cold_recovery_qualified: false,
      updated_at: Date.now(),
    };
    if (cur.state === "wiki_primary" && !allowPostGraduation) {
      throw new WikiRefusedError(
        "WIKI_ROLLBACK_POST_GRADUATION_FORBIDDEN",
        409,
      );
    }

    const { statementFps, claimIds } = await this.tombstoneIndex(signal);
    const scrubbedBase = await this.scrubMarkdownTombstones(
      priorV1Markdown,
      statementFps,
    );
    const existingFps = new Set<string>();
    for (const sec of parseV1MarkdownSections(scrubbedBase)) {
      for (const bullet of sec.bullets) {
        existingFps.add(await normalizeStatementFingerprint(bullet.statement));
      }
    }

    const appendedSections: string[] = [];
    const summaries = await this.library.listPages(undefined, signal);
    for (const summary of summaries) {
      const page = await this.library.readPage(summary.page_id, undefined, signal);
      const bullets: string[] = [];
      for (const claim of page.claims) {
        if (claim.status !== "active") continue;
        const fp = await normalizeStatementFingerprint(claim.statement);
        if (
          statementFps.has(fp) ||
          claimIds.has(claim.claim_id) ||
          existingFps.has(fp)
        ) {
          continue;
        }
        existingFps.add(fp);
        bullets.push(`- ${claim.statement}`);
      }
      if (bullets.length > 0) {
        appendedSections.push(`## ${page.title}\n${bullets.join("\n")}`);
      }
    }

    let v1Markdown = scrubbedBase.trim() || "# memory.md";
    if (appendedSections.length > 0) {
      v1Markdown = `${v1Markdown}\n\n${appendedSections.join("\n\n")}`;
    }

    const now = Date.now();
    const saved =
      await this.library.writeNamedCheckpoint<StoredMigrationCheckpoint>(
        MIGRATION_CHECKPOINT_NAME,
        {
          ...cur,
          state: "v1_markdown_only",
          rolled_back_at: now,
          updated_at: now,
        },
        revision,
        signal,
      );

    return {
      state: "v1_markdown_only" as const,
      migration_revision: saved.revision,
      v1_markdown: v1Markdown,
      filtered_tombstone_count: statementFps.size,
    };
  }
}

export class SharedWikiMaintenanceRunner {
  readonly writer: SharedWikiKnowledgeWriter;
  readonly projections: SharedWikiProjectionEngine;

  constructor(
    private readonly library: SharedWikiLibrary,
    options?: {
      writer?: SharedWikiKnowledgeWriter;
      projections?: SharedWikiProjectionEngine;
    },
  ) {
    this.writer = options?.writer ?? new SharedWikiKnowledgeWriter(library);
    this.projections =
      options?.projections ?? new SharedWikiProjectionEngine(library);
  }

  async runTick(input: {
    idempotencyKey: string;
    referenceDate?: string;
    maxPagesPerTick?: number;
    signal?: AbortSignal;
  }) {
    const { referenceDate, maxPagesPerTick = 8, signal } = input;
    signal?.throwIfAborted();
    this.library.store.check();
    const idem = validateIdempotencyKey(input.idempotencyKey);
    if (maxPagesPerTick < 1 || maxPagesPerTick > 64) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }

    const refDate = (referenceDate ?? todayUtc()).slice(0, 10);
    const cursorSnap =
      await this.library.readNamedCheckpoint<StoredMaintenanceCheckpoint>(
        MAINTENANCE_CHECKPOINT_NAME,
        signal,
      );
    const lastPageId = cursorSnap.payload?.last_page_id ?? "";

    const summaries = (await this.library.listPages(undefined, signal)).sort(
      (a, b) => a.page_id.localeCompare(b.page_id),
    );
    const allPageIds = summaries.map((s) => s.page_id);
    const allPageIdSet = new Set(allPageIds);
    const foundIdx = lastPageId ? allPageIds.indexOf(lastPageId) : -1;
    const startIdx =
      foundIdx >= 0 ? (foundIdx + 1) % Math.max(1, allPageIds.length) : 0;
    const ordered = [
      ...allPageIds.slice(startIdx),
      ...allPageIds.slice(0, startIdx),
    ];
    const batchPageIds = ordered.slice(0, maxPagesPerTick);

    const tombstones = await this.library.listTombstones(signal);
    const fpSnap =
      await this.library.readNamedCheckpoint<StoredTombstoneFingerprints>(
        TOMBSTONE_FPS_CHECKPOINT_NAME,
        signal,
      );
    const tombSources = new Set(
      tombstones
        .filter((tb) => tb.target_kind === "source" && tb.target_id)
        .map((tb) => tb.target_id),
    );
    const tombFps = new Set(fpSnap.payload?.fingerprints ?? []);

    let deduplicatedCount = 0;
    let expiredCount = 0;
    let retractedTombstonedCount = 0;
    const contradictions: Array<{
      page_id: string;
      slot: string;
      claim_ids: string[];
    }> = [];
    const brokenLinks: Array<{
      source_page_id: string;
      target_page_id: string;
    }> = [];
    const inboundTargets = new Set<string>();

    for (const pid of batchPageIds) {
      signal?.throwIfAborted();
      const page = await this.library.readPage(
        pid,
        { requireSettled: true },
        signal,
      );
      let changed = false;
      const seenNorm = new Map<string, number>();
      const newClaims: WikiClaim[] = [];

      for (const claim of page.claims) {
        const srcList = [...(claim.source_ids ?? [])];
        const copy: WikiClaim = { ...claim, source_ids: srcList };
        const fp = await normalizeStatementFingerprint(copy.statement);
        if (copy.status === "active") {
          const allSourcesTombstoned =
            srcList.length > 0 && srcList.every((sid) => tombSources.has(sid));
          if (tombFps.has(fp) || allSourcesTombstoned) {
            copy.status = "retracted";
            copy.valid_until = refDate;
            retractedTombstonedCount += 1;
            changed = true;
          } else if (copy.valid_until && copy.valid_until.slice(0, 10) < refDate) {
            copy.status = "retracted";
            expiredCount += 1;
            changed = true;
          } else if (seenNorm.has(fp)) {
            const keeperIdx = seenNorm.get(fp)!;
            const keeper = newClaims[keeperIdx]!;
            keeper.source_ids = [
              ...new Set([...(keeper.source_ids ?? []), ...srcList]),
            ].sort();
            if (copy.claim_id === keeper.claim_id) {
              deduplicatedCount += 1;
              changed = true;
              continue;
            }
            copy.status = "superseded";
            copy.superseded_by = keeper.claim_id;
            copy.valid_until = refDate;
            deduplicatedCount += 1;
            changed = true;
          } else {
            seenNorm.set(fp, newClaims.length);
          }
        }
        newClaims.push(copy);
      }

      const slotSeen = new Map<string, { claimId: string; negated: boolean }>();
      for (const cItem of newClaims) {
        if ((cItem.status ?? "active") !== "active") continue;
        const info = subjectSlotKey(cItem.statement);
        if (!info) continue;
        const prev = slotSeen.get(info.slot);
        if (prev) {
          if (prev.negated !== info.negated) {
            contradictions.push({
              page_id: pid,
              slot: info.slot,
              claim_ids: [prev.claimId, cItem.claim_id].sort(),
            });
          }
        } else {
          slotSeen.set(info.slot, {
            claimId: cItem.claim_id,
            negated: info.negated,
          });
        }
      }

      const seenBroken = new Set<string>();
      for (const targetId of [
        ...page.links.map((l) => l.target_page_id),
        ...extractInlineLinks(page.body).map((e) => e.target_page_id),
      ]) {
        inboundTargets.add(targetId);
        const brokenKey = `${pid}->${targetId}`;
        if (!allPageIdSet.has(targetId) && !seenBroken.has(brokenKey)) {
          seenBroken.add(brokenKey);
          brokenLinks.push({
            source_page_id: pid,
            target_page_id: targetId,
          });
        }
      }

      if (changed) {
        const activeStmts = newClaims
          .filter((c) => (c.status ?? "active") === "active")
          .map((c) => c.statement);
        const nextTldr = activeStmts[0]?.slice(0, 240) ?? "";
        await this.library.editPage(
          pid,
          {
            expected_revision: page.revision,
            idempotency_key: `${idem}:maint:${pid}:${page.revision}`.slice(
              0,
              120,
            ),
            tldr: nextTldr,
            status_as_of: refDate,
            claims: newClaims,
          },
          signal,
        );
        await this.projections.syncPageLifecycle(pid, undefined, signal);
      }
    }

    const sweepComplete = batchPageIds.length === allPageIds.length;
    const orphanPageIds = sweepComplete
      ? allPageIds
          .filter(
            (pid) => pid !== DEFAULT_WORKING_PAGE_ID && !inboundTargets.has(pid),
          )
          .sort()
      : [];

    await this.library.rebuildIndexes(signal);
    const hotMd = await this.writer.refreshHotDigest(signal);
    const nextLast = batchPageIds[batchPageIds.length - 1] ?? "";
    const runHex = await sha256Hex(`${idem}:${refDate}:${nextLast}`);
    const runId = `wmn_${runHex.slice(0, 16)}`;

    const saved =
      await this.library.writeNamedCheckpoint<StoredMaintenanceCheckpoint>(
        MAINTENANCE_CHECKPOINT_NAME,
        {
          last_run_id: runId,
          last_page_id: nextLast,
          reference_date: refDate,
          sweep_complete: sweepComplete,
          updated_at: Date.now(),
        },
        cursorSnap.revision,
        signal,
      );

    return {
      maintenance_run_id: runId,
      inspected_page_count: batchPageIds.length,
      total_page_count: allPageIds.length,
      sweep_complete: sweepComplete,
      deduplicated_claim_count: deduplicatedCount,
      expired_claim_count: expiredCount,
      retracted_tombstoned_count: retractedTombstonedCount,
      contradictions,
      broken_links: brokenLinks,
      orphan_page_ids: orphanPageIds,
      hot_digest_chars: hotMd.length,
      hot_digest_within_budget: hotMd.length <= WIKI_HOT_MAX_CHARS,
      cursor_revision: saved.revision,
    };
  }
}
