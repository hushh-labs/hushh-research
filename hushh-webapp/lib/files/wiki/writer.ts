/**
 * Canonical personal-wiki knowledge writer for Shared / Browser execution.
 *
 * Mirrors `consent-protocol/hushh_mcp/services/wiki_memory/writer.py`:
 * - Explicit opt-in default (`capture_opt_in: false` until owner opts in); opt-in
 *   grants zero connector, external-action, sharing, or provider-processing authority.
 * - Immediate withdrawal and `AbortController` / epoch fencing on vault lock or tab close.
 * - Excludes `consentDerived`, `receiptPrivate`, `history_*`, and assistant-only
 *   self-citation turns; strips raw credentials/secrets before hashing or saving.
 * - Deduplicates across chat switches, restarts, and browser<->pod handoff via
 *   `WikiCaptureCheckpoint`; writes `wtb_*` tombstones and bounded `root/hot.md`
 *   (`<= 8,000` chars); returns closed `WikiSaveOutcome` statuses.
 */

import { findSecretSpans } from "@/lib/pkm/secret-patterns";

import {
  MAX_CLAIM_CHARS,
  WIKI_HOT_MAX_CHARS,
  WikiRefusedError,
  sha256Hex,
  validateClaimId,
  validatePageId,
  type WikiClaim,
  type WikiSaveOutcomeStatus,
  type WikiSourceRef,
} from "./contracts";
import { SharedWikiLibrary, type SynthesisBatchItemInput } from "./library";

export const DEFAULT_WORKING_PAGE_ID = "wpg_0000000000000001";
export const DEFAULT_WORKING_PAGE_TITLE = "Working Memory";

export interface CaptureEventInput {
  conversationId: string;
  eventId: string;
  role: "user" | "assistant";
  content: string;
  invocationId?: string;
  consentDerived?: boolean;
  receiptPrivate?: boolean;
  observedAt?: string;
}

export interface RegisteredCaptureSource {
  event: CaptureEventInput;
  source: Required<WikiSourceRef>;
  scrubbedText: string;
}

export type WikiSynthesizerFn = (
  sources: RegisteredCaptureSource[],
  library: SharedWikiLibrary,
  signal: AbortSignal,
) => Promise<SynthesisBatchItemInput[]>;

export function stripSecretSpansForWiki(text: string): {
  scrubbed: string;
  count: number;
} {
  if (!text) return { scrubbed: "", count: 0 };
  const spans = findSecretSpans(text);
  if (spans.length === 0) return { scrubbed: text, count: 0 };
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += `${text.slice(cursor, span.start)}[credential omitted]`;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { scrubbed: out, count: spans.length };
}

const CREDENTIAL_LABEL_WORDS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwd",
  "secret",
  "token",
  "bearer",
  "pin",
  "cvv",
  "cvc",
]);

function isOmissionOnly(text: string): boolean {
  const residual = text
    .replaceAll("[credential omitted]", "")
    .replace(/^[\s.,:;=-]+|[\s.,:;=-]+$/g, "");
  if (residual.length === 0) return true;
  return CREDENTIAL_LABEL_WORDS.has(residual.toLowerCase());
}

function eventKey(conversationId: string, eventId: string): string {
  return JSON.stringify([conversationId, eventId]);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export class SharedWikiKnowledgeWriter {
  private abortEpoch = 0;
  private abortReason: "withdrawn" | "vault_locked" | null = null;
  private activeController: AbortController | null = null;

  constructor(private readonly library: SharedWikiLibrary) {}

  static captureAuthorityPosture(captureOptIn: boolean) {
    return {
      wiki_capture_enabled: Boolean(captureOptIn),
      connector_reads: false,
      external_actions: false,
      recipient_sharing: false,
      provider_processing: false,
    } as const;
  }

  abort(reason: "withdrawn" | "vault_locked" = "vault_locked"): number {
    this.abortEpoch += 1;
    this.abortReason = reason;
    this.activeController?.abort();
    this.activeController = null;
    return this.abortEpoch;
  }

  private async opaque16(label: string): Promise<string> {
    const hex = await sha256Hex(`${this.library.owner}|${label}`);
    return hex.slice(0, 16);
  }

  async sourceIdForEvent(
    conversationId: string,
    eventId: string,
  ): Promise<string> {
    return `wsr_${await this.opaque16(`event:${conversationId}:${eventId}`)}`;
  }

  async claimIdForStatement(pageId: string, statement: string): Promise<string> {
    return `wcl_${await this.opaque16(`claim:${pageId}:${statement.trim().toLowerCase()}`)}`;
  }

  async tombstoneIdForTarget(
    targetKind: string,
    targetId: string,
    gen: number,
  ): Promise<string> {
    return `wtb_${await this.opaque16(`tb:${targetKind}:${targetId}:${gen}`)}`;
  }

  async setCaptureOptIn(
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<{
    capture_opt_in: boolean;
    opt_in_updated_at: number;
    authority: ReturnType<typeof SharedWikiKnowledgeWriter.captureAuthorityPosture>;
  }> {
    const cp = await this.library.readCaptureCheckpoint(signal);
    const nowMs = Date.now();
    if (!enabled) {
      this.abort("withdrawn");
    }
    const saved = await this.library.writeCaptureCheckpoint(
      {
        ...cp,
        capture_opt_in: Boolean(enabled),
        opt_in_updated_at: nowMs,
        edit_generation: cp.edit_generation + (enabled ? 0 : 1),
      },
      signal,
    );
    return {
      capture_opt_in: saved.capture_opt_in,
      opt_in_updated_at: saved.opt_in_updated_at,
      authority: SharedWikiKnowledgeWriter.captureAuthorityPosture(
        saved.capture_opt_in,
      ),
    };
  }

  async refreshHotDigest(signal?: AbortSignal): Promise<string> {
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

    const summaries = await this.library.listPages(undefined, signal);
    summaries.sort(
      (a, b) => b.updated_at - a.updated_at || a.page_id.localeCompare(b.page_id),
    );

    const header = "# Personal Wiki Hot Digest\n";
    const lines: string[] = [header];
    let used = header.length;

    for (const summary of summaries) {
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
      const activeClaims = page.claims.filter(
        (c) =>
          c.status === "active" &&
          !deadClaims.has(c.claim_id) &&
          !c.source_ids.some((s) => deadSources.has(s)),
      );
      if (
        (page.claims.length > 0 && activeClaims.length === 0) ||
        (activeClaims.length === 0 && !page.tldr)
      ) {
        continue;
      }
      const sectionLines = [
        `\n## ${page.title} (${page.page_id}@r${page.revision})`,
      ];
      if (page.tldr) sectionLines.push(`- Summary: ${page.tldr}`);
      for (const claim of activeClaims.slice(0, 8)) {
        sectionLines.push(`- [${claim.claim_id}] ${claim.statement}`);
      }
      const block = `${sectionLines.join("\n")}\n`;
      if (used + block.length > WIKI_HOT_MAX_CHARS) {
        for (const single of sectionLines) {
          const candidate = `${single}\n`;
          if (used + candidate.length <= WIKI_HOT_MAX_CHARS) {
            lines.push(candidate);
            used += candidate.length;
          } else {
            break;
          }
        }
        break;
      }
      lines.push(block);
      used += block.length;
    }

    const digest = lines.join("").trim().slice(0, WIKI_HOT_MAX_CHARS).trimEnd();
    await this.library.writeHotDigest(digest, signal);
    return digest;
  }

  async withdrawCapture(
    options: {
      conversationId?: string;
      eventKeys?: string[];
      claimIds?: string[];
      disableOptIn?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{
    status: "withdrawn";
    tombstone_ids: string[];
    edit_generation: number;
    capture_opt_in: boolean;
  }> {
    this.abort("withdrawn");
    const cp = await this.library.readCaptureCheckpoint(signal);
    const nextGen = cp.edit_generation + 1;
    const nowMs = Date.now();

    const withdrawnConversations = [...cp.withdrawn_conversations];
    if (
      options.conversationId &&
      !withdrawnConversations.includes(options.conversationId)
    ) {
      withdrawnConversations.push(options.conversationId);
    }
    const withdrawnEventKeys = [...cp.withdrawn_event_keys];
    for (const key of options.eventKeys ?? []) {
      if (key && !withdrawnEventKeys.includes(key)) {
        withdrawnEventKeys.push(key);
      }
    }

    const targetSources = new Set<string>();
    if (options.conversationId) {
      for (const msgId of cp.conversations[options.conversationId] ?? []) {
        targetSources.add(
          await this.sourceIdForEvent(options.conversationId, msgId),
        );
      }
    }
    for (const rawKey of options.eventKeys ?? []) {
      try {
        const parsed = JSON.parse(rawKey) as unknown;
        if (Array.isArray(parsed) && parsed.length === 2) {
          targetSources.add(
            await this.sourceIdForEvent(String(parsed[0]), String(parsed[1])),
          );
        }
      } catch {
        // Ignore malformed key
      }
    }

    const validatedClaims = new Set(
      (options.claimIds ?? []).map((cid) => validateClaimId(cid)),
    );
    const tombstoneIds: string[] = [];

    for (const srcId of [...targetSources].sort()) {
      const tbId = await this.tombstoneIdForTarget("source", srcId, nextGen);
      await this.library.putTombstone(
        {
          tombstone_id: tbId,
          target_kind: "source",
          target_id: srcId,
          reason_code: "capture_withdrawn",
          created_at: nowMs,
        },
        `tb:${tbId}`,
        signal,
      );
      tombstoneIds.push(tbId);
    }

    if (options.conversationId) {
      const tbId = await this.tombstoneIdForTarget(
        "capture_conversation",
        options.conversationId,
        nextGen,
      );
      await this.library.putTombstone(
        {
          tombstone_id: tbId,
          target_kind: "capture_conversation",
          target_id: options.conversationId,
          reason_code: "capture_withdrawn",
          created_at: nowMs,
        },
        `tb:${tbId}`,
        signal,
      );
      tombstoneIds.push(tbId);
    }

    for (const summary of await this.library.listPages(undefined, signal)) {
      const page = await this.library.readPage(
        summary.page_id,
        { requireSettled: true },
        signal,
      );
      let changed = false;
      const updatedClaims: WikiClaim[] = [];
      for (const claim of page.claims) {
        const matchesClaim = validatedClaims.has(claim.claim_id);
        const matchesSource = claim.source_ids.some((s) =>
          targetSources.has(s),
        );
        if ((matchesClaim || matchesSource) && claim.status !== "retracted") {
          changed = true;
          updatedClaims.push({ ...claim, status: "retracted" });
          const tbId = await this.tombstoneIdForTarget(
            "claim",
            claim.claim_id,
            nextGen,
          );
          await this.library.putTombstone(
            {
              tombstone_id: tbId,
              target_kind: "claim",
              target_id: claim.claim_id,
              reason_code: "capture_withdrawn",
              created_at: nowMs,
              page_id: page.page_id,
            },
            `tb:${tbId}`,
            signal,
          );
          tombstoneIds.push(tbId);
        } else {
          updatedClaims.push(claim);
        }
      }
      if (changed) {
        const remainingActive = updatedClaims
          .filter((c) => c.status === "active")
          .map((c) => c.statement);
        const nextTldr = (
          remainingActive[remainingActive.length - 1] ?? ""
        ).slice(0, 280);
        await this.library.editPage(
          page.page_id,
          {
            expected_revision: page.revision,
            idempotency_key: `withdraw:${page.page_id}:g${nextGen}`,
            tldr: nextTldr,
            claims: updatedClaims,
          },
          signal,
        );
      }
    }

    const updatedCp = await this.library.writeCaptureCheckpoint(
      {
        ...cp,
        capture_opt_in: options.disableOptIn ? false : cp.capture_opt_in,
        opt_in_updated_at: options.disableOptIn ? nowMs : cp.opt_in_updated_at,
        edit_generation: nextGen,
        withdrawn_conversations: withdrawnConversations,
        withdrawn_event_keys: withdrawnEventKeys,
      },
      signal,
    );
    await this.refreshHotDigest(signal);
    return {
      status: "withdrawn",
      tombstone_ids: tombstoneIds,
      edit_generation: nextGen,
      capture_opt_in: updatedCp.capture_opt_in,
    };
  }

  async captureEvents(
    events: CaptureEventInput[],
    options?: {
      taggedInvocations?: ReadonlySet<string>;
      receiptPrivateInvocations?: ReadonlySet<string>;
      targetPageId?: string;
      targetPageTitle?: string;
      targetFolder?: string;
      synthesizer?: WikiSynthesizerFn;
      signal?: AbortSignal;
    },
  ): Promise<{
    status: WikiSaveOutcomeStatus;
    saved_page_ids: string[];
    saved_claim_ids: string[];
    skipped_reasons: Record<string, number>;
    reason?: string;
    code?: string;
  }> {
    const startEpoch = this.abortEpoch;
    const controller = new AbortController();
    this.activeController = controller;
    const externalSignal = options?.signal;
    if (externalSignal?.aborted) {
      return {
        status: "pending",
        reason: "aborted",
        saved_page_ids: [],
        saved_claim_ids: [],
        skipped_reasons: {},
      };
    }
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const cp = await this.library.readCaptureCheckpoint(controller.signal);
      if (!cp.capture_opt_in) {
        return {
          status: "disabled",
          saved_page_ids: [],
          saved_claim_ids: [],
          skipped_reasons: { opt_in_disabled: events.length },
        };
      }

      const skipped: Record<string, number> = {};
      const bump = (reason: string) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
      };

      const withdrawnConvs = new Set(cp.withdrawn_conversations);
      const withdrawnKeys = new Set(cp.withdrawn_event_keys);
      const processedSources = new Set(cp.processed_source_ids);

      const preliminary: Array<{
        event: CaptureEventInput;
        sourceId: string;
        scrubbed: string;
      }> = [];

      for (const ev of events) {
        if (!ev.conversationId || !ev.eventId) {
          bump("invalid_event");
          continue;
        }
        if (
          withdrawnConvs.has(ev.conversationId) ||
          withdrawnKeys.has(eventKey(ev.conversationId, ev.eventId))
        ) {
          bump("withdrawn");
          continue;
        }
        if (
          ev.consentDerived ||
          (ev.invocationId && options?.taggedInvocations?.has(ev.invocationId))
        ) {
          bump("consent_derived");
          continue;
        }
        if (
          ev.receiptPrivate ||
          (ev.invocationId &&
            options?.receiptPrivateInvocations?.has(ev.invocationId))
        ) {
          bump("receipt_private");
          continue;
        }
        if (ev.invocationId?.startsWith("history_")) {
          bump("seeded_history");
          continue;
        }
        const sourceId = await this.sourceIdForEvent(
          ev.conversationId,
          ev.eventId,
        );
        if (
          (cp.conversations[ev.conversationId] ?? []).includes(ev.eventId) ||
          processedSources.has(sourceId)
        ) {
          bump("duplicate");
          continue;
        }
        const { scrubbed } = stripSecretSpansForWiki(ev.content);
        if (isOmissionOnly(scrubbed)) {
          bump("credential_only");
          continue;
        }
        preliminary.push({ event: ev, sourceId, scrubbed: scrubbed.trim() });
      }

      const hasOwnerSource = preliminary.some(
        (item) => item.event.role === "user",
      );
      const eligible = preliminary.filter((item) => {
        if (item.event.role !== "user" && !hasOwnerSource) {
          bump("assistant_self_citation");
          return false;
        }
        return true;
      });

      if (eligible.length === 0) {
        const onlyWithdrawn =
          Boolean(skipped.withdrawn) && Object.keys(skipped).length === 1;
        return {
          status: onlyWithdrawn ? "withdrawn" : "saved",
          saved_page_ids: [],
          saved_claim_ids: [],
          skipped_reasons: skipped,
        };
      }

      if (this.abortEpoch !== startEpoch || controller.signal.aborted) {
        return this.abortedOutcome();
      }

      const today = todayUtc();
      const registered: RegisteredCaptureSource[] = [];
      for (const item of eligible) {
        if (this.abortEpoch !== startEpoch || controller.signal.aborted) {
          return this.abortedOutcome();
        }
        const digest = await sha256Hex(item.scrubbed);
        const source = await this.library.registerSource(
          {
            source_id: item.sourceId,
            kind: "chat_turn",
            locator: `chat:${item.event.conversationId}/${item.event.eventId}`,
            content_sha256: digest,
            observed_at: item.event.observedAt ?? today,
            consent_derived: false,
          },
          `src:${item.sourceId}`,
          controller.signal,
        );
        registered.push({
          event: item.event,
          source,
          scrubbedText: item.scrubbed,
        });
      }

      const pageId = validatePageId(
        options?.targetPageId ?? DEFAULT_WORKING_PAGE_ID,
      );
      const batchItems = options?.synthesizer
        ? await options.synthesizer(registered, this.library, controller.signal)
        : await this.defaultBatchItems(
            registered,
            pageId,
            options?.targetPageTitle ?? DEFAULT_WORKING_PAGE_TITLE,
            options?.targetFolder ?? "root",
            controller.signal,
          );

      if (this.abortEpoch !== startEpoch || controller.signal.aborted) {
        return this.abortedOutcome();
      }

      const savedPageIds: string[] = [];
      const savedClaimIds: string[] = [];
      if (batchItems.length > 0) {
        const seed = registered.map((r) => r.source.source_id).join("|");
        const idem = `cap:${(await sha256Hex(seed)).slice(0, 24)}`;
        const receipt = await this.library.commitSynthesisBatch(
          { items: batchItems, idempotency_key: idem },
          controller.signal,
        );
        if (receipt.state !== "finalized") {
          return {
            status: "pending",
            saved_page_ids: [],
            saved_claim_ids: [],
            skipped_reasons: skipped,
          };
        }
        for (const spec of batchItems) {
          if (spec.page_id) savedPageIds.push(spec.page_id);
          for (const cl of spec.claims ?? []) {
            if ((cl.status ?? "active") === "active") {
              savedClaimIds.push(cl.claim_id);
            }
          }
        }
      }

      const latestCp = await this.library.readCaptureCheckpoint(
        controller.signal,
      );
      if (
        latestCp.edit_generation !== cp.edit_generation ||
        !latestCp.capture_opt_in
      ) {
        return {
          status: "withdrawn",
          saved_page_ids: [],
          saved_claim_ids: [],
          skipped_reasons: skipped,
        };
      }

      const conversations: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(latestCp.conversations)) {
        conversations[k] = [...v];
      }
      const processed = [...latestCp.processed_source_ids];
      for (const item of registered) {
        const list = (conversations[item.event.conversationId] ??= []);
        if (!list.includes(item.event.eventId)) list.push(item.event.eventId);
        if (!processed.includes(item.source.source_id)) {
          processed.push(item.source.source_id);
        }
      }

      await this.library.writeCaptureCheckpoint(
        {
          ...latestCp,
          conversations,
          processed_source_ids: processed,
        },
        controller.signal,
      );
      await this.refreshHotDigest(controller.signal);
      return {
        status: "saved",
        saved_page_ids: savedPageIds,
        saved_claim_ids: savedClaimIds,
        skipped_reasons: skipped,
      };
    } catch (error) {
      if (this.abortEpoch !== startEpoch || controller.signal.aborted) {
        return this.abortedOutcome();
      }
      if (error instanceof WikiRefusedError) {
        return {
          status: error.code === "WIKI_BATCH_INCOMPLETE" ? "pending" : "failed",
          code: error.code,
          saved_page_ids: [],
          saved_claim_ids: [],
          skipped_reasons: {},
        };
      }
      return {
        status: "failed",
        code: "WIKI_WRITE_ERROR",
        saved_page_ids: [],
        saved_claim_ids: [],
        skipped_reasons: {},
      };
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  private async defaultBatchItems(
    registered: RegisteredCaptureSource[],
    pageId: string,
    title: string,
    folder: string,
    signal: AbortSignal,
  ): Promise<SynthesisBatchItemInput[]> {
    const today = todayUtc();
    let expectedRev = 0;
    const claimsById = new Map<string, WikiClaim>();
    const sourceIds: string[] = [];
    let body = "";

    try {
      const existing = await this.library.readPage(
        pageId,
        { requireSettled: true },
        signal,
      );
      expectedRev = existing.revision;
      for (const c of existing.claims) claimsById.set(c.claim_id, { ...c });
      sourceIds.push(...existing.source_ids);
      body = existing.body;
    } catch (error) {
      if (
        !(error instanceof WikiRefusedError && error.code === "WIKI_NOT_FOUND")
      ) {
        throw error;
      }
    }

    for (const item of registered) {
      if (item.event.role !== "user") continue;
      const stmt = item.scrubbedText.slice(0, MAX_CLAIM_CHARS).trim();
      if (!stmt) continue;
      if (!sourceIds.includes(item.source.source_id)) {
        sourceIds.push(item.source.source_id);
      }
      const cid = await this.claimIdForStatement(pageId, stmt);
      const prev = claimsById.get(cid);
      const mergedSources = [
        ...new Set([...(prev?.source_ids ?? []), item.source.source_id]),
      ];
      claimsById.set(cid, {
        claim_id: cid,
        statement: stmt,
        status: "active",
        confidence: 1.0,
        source_ids: mergedSources,
        observed_at: item.event.observedAt ?? today,
      });
    }

    if (claimsById.size === 0) return [];
    const active = [...claimsById.values()]
      .filter((c) => c.status === "active")
      .map((c) => c.statement);
    const tldr = (active[active.length - 1] ?? title).slice(0, 280);
    return [
      {
        page_id: pageId,
        expected_revision: expectedRev,
        title,
        folder,
        tldr,
        status_as_of: today,
        body: body || "Owner opted-in working notes and cited statements.",
        claims: [...claimsById.values()],
        source_ids: sourceIds,
      },
    ];
  }

  private abortedOutcome(): {
    status: WikiSaveOutcomeStatus;
    reason: string;
    saved_page_ids: string[];
    saved_claim_ids: string[];
    skipped_reasons: Record<string, number>;
  } {
    return {
      status: this.abortReason === "withdrawn" ? "withdrawn" : "pending",
      reason: this.abortReason ?? "aborted",
      saved_page_ids: [],
      saved_claim_ids: [],
      skipped_reasons: {},
    };
  }
}
