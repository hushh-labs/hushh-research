"use client";

import {
  snapshotValidatedAuthSessionOwner,
  subscribeAuthSessionGeneration,
} from "@/lib/auth/session-owner";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import {
  isVaultSessionEpochCurrent,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import {
  createChatMemoryRuntime,
  type ChatMemoryTrigger,
} from "./chat-memory-runtime";
import { rewriteChatMemory } from "./chat-memory-rewrite";
import type { SharedFilesAccess } from "@/lib/files/shared/store";
import type { SynthesisBatchItemInput } from "@/lib/files/wiki/library";
import type { WikiClaim } from "@/lib/files/wiki/contracts";
import type { RegisteredCaptureSource, WikiSynthesizerFn } from "@/lib/files/wiki/writer";
import type { WikiProjectionSyncTransport } from "@/lib/files/wiki/pkm-projection-sync";

type Runtime = ReturnType<typeof createChatMemoryRuntime>;
type OwnerRuntime = {
  userId: string;
  epoch: number;
  token: string;
  vaultKey: string;
  runtime: Runtime;
  readToken: () => string | null;
  dispose: () => void;
};
let active: OwnerRuntime | null = null;

/** One unlocked owner writer survives Chat → Memory navigation and token rotation. Lock retires it. */
export function ownerChatMemory(input: {
  userId: string;
  vaultKey: string;
  vaultEpoch: number;
  token: string;
  readToken: () => string | null;
}): Runtime {
  if (
    active?.userId === input.userId &&
    active.epoch === input.vaultEpoch &&
    active.vaultKey === input.vaultKey
  ) {
    active.token = input.token;
    active.readToken = input.readToken;
    return active.runtime;
  }
  active?.dispose();
  const liveToken = () => {
    const token = entry.readToken();
    return token && token.trim() ? token : null;
  };
  const current = () =>
    active === entry &&
    isVaultSessionEpochCurrent(input.vaultEpoch) &&
    snapshotValidatedAuthSessionOwner()?.userId === input.userId &&
    Boolean(liveToken());
  const getSession = () => {
    if (!current()) return null;
    const vaultOwnerToken = liveToken();
    return vaultOwnerToken
      ? {
          userId: input.userId,
          vaultKey: input.vaultKey,
          vaultOwnerToken,
          isCurrent: current,
        }
      : null;
  };

  const resolveSharedWiki = async (options?: { initializeIfNeeded?: boolean }) => {
    const session = getSession();
    if (!session || (await ownerContentIsPrivate())) return null;
    const { ensureActiveSharedWiki, peekActiveSharedWiki } = await import(
      "@/lib/files/wiki/active-shared-wiki"
    );
    const existing = peekActiveSharedWiki();
    if (existing) {
      if (options?.initializeIfNeeded) return existing;
      const initialized = await existing.store.readyIfInitialized().catch(() => false);
      return initialized ? existing : null;
    }
    const ensured = ensureActiveSharedWiki({
      userId: session.userId,
      vaultKey: session.vaultKey,
      vaultOwnerToken: session.vaultOwnerToken,
      vaultEpoch: input.vaultEpoch,
      readToken: liveToken,
    });
    if (!ensured) return null;
    if (options?.initializeIfNeeded) return ensured;
    const initialized = await ensured.store.readyIfInitialized().catch(() => false);
    return initialized ? ensured : null;
  };

  const buildMarkdownSectionSynthesizer = async (
    proposedMarkdown: string,
    previousMarkdown?: string,
  ): Promise<WikiSynthesizerFn | undefined> => {
    const [{ parseV1MarkdownSections, normalizeStatementFingerprint }, { WikiRefusedError, sha256Hex }, { DEFAULT_WORKING_PAGE_ID, DEFAULT_WORKING_PAGE_TITLE, SharedWikiKnowledgeWriter }] =
      await Promise.all([
        import("@/lib/files/wiki/migration-and-maintenance"),
        import("@/lib/files/wiki/contracts"),
        import("@/lib/files/wiki/writer"),
      ]);

    const parsedSections = parseV1MarkdownSections(proposedMarkdown);
    if (parsedSections.length === 0) {
      return undefined;
    }

    const priorFps = new Set<string>();
    if (previousMarkdown) {
      for (const sec of parseV1MarkdownSections(previousMarkdown)) {
        for (const bullet of sec.bullets) {
          priorFps.add(await normalizeStatementFingerprint(bullet.statement));
        }
      }
    }

    const targetSections: typeof parsedSections = [];
    for (const sec of parsedSections) {
      const freshBullets: typeof sec.bullets = [];
      for (const bullet of sec.bullets) {
        const fp = await normalizeStatementFingerprint(bullet.statement);
        if (!priorFps.has(fp)) {
          freshBullets.push(bullet);
        }
      }
      if (freshBullets.length > 0) {
        targetSections.push({ title: sec.title, bullets: freshBullets });
      }
    }

    const chosenSections =
      targetSections.length > 0
        ? targetSections
        : priorFps.size === 0
          ? parsedSections
          : [];
    if (chosenSections.length === 0) {
      return undefined;
    }

    return async (
      registered: RegisteredCaptureSource[],
      library,
      signal,
    ): Promise<SynthesisBatchItemInput[]> => {
      const userSources = registered.filter((item) => item.event.role === "user");
      if (userSources.length === 0) return [];
      const newSourceIds = userSources.map((item) => item.source.source_id);
      const today = new Date().toISOString().slice(0, 10);
      const writer = new SharedWikiKnowledgeWriter(library);
      const batchItems: SynthesisBatchItemInput[] = [];

      for (const sec of chosenSections.slice(0, 12)) {
        signal?.throwIfAborted();
        const normTitle = sec.title
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .join(" ");
        const pageId =
          !normTitle || normTitle === DEFAULT_WORKING_PAGE_TITLE.toLowerCase()
            ? DEFAULT_WORKING_PAGE_ID
            : `wpg_${(await sha256Hex(`${library.owner}|v1_section_page|${normTitle}`)).slice(0, 16)}`;

        let existingPage: Awaited<ReturnType<typeof library.readPage>> | null = null;
        try {
          existingPage = await library.readPage(pageId, { requireSettled: true }, signal);
        } catch (err) {
          if (!(err instanceof WikiRefusedError) || err.code !== "WIKI_NOT_FOUND") {
            throw err;
          }
        }

        const claimsById = new Map<string, WikiClaim>();
        for (const existingClaim of existingPage?.claims ?? []) {
          claimsById.set(existingClaim.claim_id, { ...existingClaim });
        }
        const mergedSourceIds = new Set<string>(existingPage?.source_ids ?? []);
        for (const sid of newSourceIds) {
          mergedSourceIds.add(sid);
        }

        const appendedStatements: string[] = [];
        for (const bullet of sec.bullets) {
          const stmt = bullet.statement.trim();
          if (!stmt) continue;
          const claimId = await writer.claimIdForStatement(pageId, stmt);
          const prior = claimsById.get(claimId);
          if (prior && (prior.status === "retracted" || prior.status === "superseded")) {
            continue;
          }
          const combinedClaimSources = [
            ...new Set([...(prior?.source_ids ?? []), ...newSourceIds]),
          ];
          claimsById.set(claimId, {
            claim_id: claimId,
            statement: stmt,
            status: "active",
            confidence: 1.0,
            source_ids: combinedClaimSources,
            observed_at: prior?.observed_at || today,
          });
          if (!prior) {
            appendedStatements.push(stmt);
          }
        }

        const claims = [...claimsById.values()];
        const activeStatements = claims
          .filter((claim) => (claim.status ?? "active") === "active")
          .map((claim) => claim.statement);
        if (activeStatements.length === 0 && !existingPage) continue;

        const body =
          existingPage && existingPage.body.trim()
            ? appendedStatements.length > 0
              ? `${existingPage.body.trim()}\n${appendedStatements.map((s) => `- ${s}`).join("\n")}`
              : existingPage.body
            : activeStatements.map((s) => `- ${s}`).join("\n");
        const tldr = (
          activeStatements[activeStatements.length - 1] ??
          existingPage?.tldr ??
          sec.title
        ).slice(0, 280);

        batchItems.push({
          page_id: pageId,
          expected_revision: existingPage?.revision ?? 0,
          title: existingPage?.title || sec.title.slice(0, 120) || DEFAULT_WORKING_PAGE_TITLE,
          folder: existingPage?.folder || "root",
          tldr,
          status_as_of: today,
          body,
          claims,
          source_ids: [...mergedSourceIds],
        });
      }

      return batchItems;
    };
  };

  const captureMessagesIntoSharedWiki = async (
    wiki: NonNullable<Awaited<ReturnType<typeof resolveSharedWiki>>>,
    messages: readonly {
      id: string;
      conversationId: string;
      role: "user" | "assistant";
      content: string;
      consentDerived?: boolean;
    }[],
    options?: {
      proposedMarkdown?: string;
      previousMarkdown?: string;
      explicitOwnerSave?: boolean;
      signal?: AbortSignal;
    },
  ) => {
    const {
      SharedWikiKnowledgeWriter,
      SharedWikiProjectionEngine,
    } = await import("@/lib/files/wiki");
    const { normalizeStatementFingerprint } = await import(
      "@/lib/files/wiki/migration-and-maintenance"
    );
    const {
      classifyWikiClaimsForPkm,
      fetchProjectionSharingImpact,
      inspectPkmConflictsForProjection,
      materializeWikiReceiptToPkm,
    } = await import("@/lib/files/wiki/pkm-projection-sync");

    const synthesizer = options?.proposedMarkdown
      ? await buildMarkdownSectionSynthesizer(
          options.proposedMarkdown,
          options.previousMarkdown,
        )
      : undefined;

    const writer = new SharedWikiKnowledgeWriter(wiki);
    const captured = await writer.captureEvents(
      messages.map((m) => ({
        conversationId: m.conversationId,
        eventId: m.id,
        role: m.role,
        content: m.content,
        consentDerived: m.consentDerived,
      })),
      {
        synthesizer,
        explicitOwnerSave: options?.explicitOwnerSave,
        signal: options?.signal,
      },
    );
    if (captured.status !== "saved" || captured.saved_page_ids.length === 0) {
      return;
    }

    const projections = new SharedWikiProjectionEngine(wiki);
    for (const pageId of captured.saved_page_ids) {
      await projections.syncPageLifecycle(pageId, undefined, options?.signal);
    }

    if (!current() || captured.saved_claim_ids.length === 0) return;
    const checkpoint = await wiki.readCaptureCheckpoint(options?.signal);
    const autoSaveIso = new Date(
      checkpoint.opt_in_updated_at || Date.now(),
    ).toISOString();

    const savedClaims: Array<{
      pageId: string;
      claimId: string;
      statement: string;
      fingerprint: string;
    }> = [];
    for (const pageId of captured.saved_page_ids) {
      const page = await wiki
        .readPage(pageId, { requireSettled: true }, options?.signal)
        .catch(() => null);
      if (!page) continue;
      for (const claim of page.claims) {
        if (
          claim.status === "active" &&
          captured.saved_claim_ids.includes(claim.claim_id)
        ) {
          savedClaims.push({
            pageId,
            claimId: claim.claim_id,
            statement: claim.statement,
            fingerprint: await normalizeStatementFingerprint(claim.statement),
          });
        }
      }
    }
    if (savedClaims.length === 0 || !current()) return;

    const classified = await classifyWikiClaimsForPkm(
      wiki.access,
      savedClaims.map((c) => c.statement),
      options?.signal,
    );
    for (const item of savedClaims) {
      if (!current()) return;
      const mapping =
        classified.find((m) => m.fingerprint === item.fingerprint) ??
        classified.find(
          (m) => m.statement.toLowerCase() === item.statement.toLowerCase(),
        );
      if (!mapping) continue;

      const [{ conflict, specialistSnapshot, existingDomainData }, impact] =
        await Promise.all([
          inspectPkmConflictsForProjection(wiki.access, {
            domain: mapping.targetDomain,
            jsonPath: mapping.jsonPath,
            statement: item.statement,
            proposedValue: mapping.proposedValue,
          }),
          mapping.sharingImpact
            ? Promise.resolve(mapping.sharingImpact)
            : fetchProjectionSharingImpact(
                wiki.access,
                mapping.targetDomain,
                mapping.jsonPath,
              ).catch(() => ({
                activeRecipientCount: 0,
                recipientLabels: [],
                entersNextExportRevision: false,
                summary: "",
                affectedGrantIds: [],
                affectedExportIds: [],
              })),
        ]);

      const receipt = await projections.deriveProjection(
        {
          pageId: item.pageId,
          claimId: item.claimId,
          targetDomain: mapping.targetDomain,
          jsonPath: mapping.jsonPath,
          idempotencyKey: `chatproj:${item.pageId}:${item.claimId}`.slice(0, 128),
          activeRecipientCount: impact.activeRecipientCount,
          ownerConfirmed: false,
          requireOwnerConfirmation: mapping.requiresConfirmation,
          proposedValue: mapping.proposedValue,
          specialistSnapshot,
          existingDomainData,
        },
        options?.signal,
      );

      if (receipt.state === "materialized" && !conflict) {
        const outcome = await materializeWikiReceiptToPkm(
          wiki.access,
          {
            receiptId: receipt.receipt_id,
            domain: receipt.domain,
            jsonPath: receipt.json_path,
            pageId: receipt.page_id,
            pageRevision: receipt.page_revision,
            claimId: receipt.claim_id,
            sourceRevision: receipt.source_revision,
            statement: item.statement,
            proposedValue: mapping.proposedValue,
          },
          {
            ownerConfirmed: false,
            explicitChatSave: Boolean(options?.explicitOwnerSave),
            surface: "chat",
            autoSaveEnabledAtIso: autoSaveIso,
            sharingImpactOverride: impact,
          },
        ).catch(() => ({ outcome: "requires_upgrade" as const }));

        if (outcome.outcome === "conflicted") {
          await wiki.putProjectionReceipt(
            {
              ...receipt,
              source_revision: receipt.source_revision + 1,
              state: "conflicted",
              exposure_eligibility: false,
              specialist_disagreement: outcome.conflict,
            },
            `chatproj_conf:${item.pageId}:${item.claimId}`.slice(0, 128),
            options?.signal,
          );
        } else if (outcome.outcome === "requires_upgrade" || outcome.outcome === "requires_confirmation") {
          await projections.deriveProjection(
            {
              pageId: item.pageId,
              claimId: item.claimId,
              targetDomain: mapping.targetDomain,
              jsonPath: mapping.jsonPath,
              idempotencyKey: `chatproj_cand:${item.pageId}:${item.claimId}`.slice(0, 128),
              activeRecipientCount: Math.max(1, impact.activeRecipientCount),
              ownerConfirmed: false,
              requireOwnerConfirmation: true,
              proposedValue: mapping.proposedValue,
              specialistSnapshot,
              existingDomainData,
              sourceRevision: receipt.source_revision + 1,
            },
            options?.signal,
          );
        }
      }
    }
  };

  const syncPrivatePodWikiAndProjections = async (input: {
    markdown: string;
    reason: ChatMemoryTrigger;
  }) => {
    const session = getSession();
    if (!session) return;
    const { ApiService } = await import("@/lib/services/api-service");
    const { syncWikiPagesToPkmProjections } = await import(
      "@/lib/files/wiki/pkm-projection-sync"
    );

    const podJson = async <T>(
      path: string,
      init: RequestInit = {},
    ): Promise<T> => {
      const response = await ApiService.ownerPodRequest(
        `files/${path}`,
        init,
        false,
        undefined,
        undefined,
        current,
      );
      if (!response.ok) {
        throw new Error(`POD_FILES_${response.status}`);
      }
      return response.json() as Promise<T>;
    };

    const podTransport: WikiProjectionSyncTransport = {
      overview: (signal) =>
        podJson("wiki/overview", { method: "GET", signal }),
      readPage: (pageId, signal) =>
        podJson(`wiki/page?${new URLSearchParams({ page_id: pageId })}`, {
          method: "GET",
          signal,
        }),
      deriveProjection: (params, signal) =>
        podJson("wiki/projection/derive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page_id: params.pageId,
            claim_id: params.claimId,
            target_domain: params.targetDomain,
            json_path: params.jsonPath,
            active_recipient_count: params.activeRecipientCount,
            owner_confirmed: params.ownerConfirmed,
            require_owner_confirmation: params.requireOwnerConfirmation,
            ...(params.conflictAuthority
              ? { conflict_authority: params.conflictAuthority }
              : {}),
            ...(params.conflictReason
              ? { conflict_reason: params.conflictReason }
              : {}),
            ...(params.conflictPath
              ? { conflict_path: params.conflictPath }
              : {}),
            request_id: params.requestId,
          }),
          signal,
        }),
    };

    const overview = await podTransport.overview().catch(() => null);
    if (!overview || (!overview.captureOptIn && input.reason !== "remember")) {
      return;
    }

    await podJson("wiki/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "compile_and_verify",
        v1_markdown: input.markdown,
        chat_key_verified: true,
        request_id: crypto.randomUUID(),
      }),
    });

    if (!current()) return;
    const podAccess: SharedFilesAccess = {
      owner: session.userId,
      vaultKey: session.vaultKey,
      ownerToken: session.vaultOwnerToken,
      check: () => {
        if (!current()) {
          throw new DOMException("Memory session changed.", "AbortError");
        }
      },
    };
    await syncWikiPagesToPkmProjections(podAccess, podTransport, {
      explicitChatSave: input.reason === "remember",
      surface: "chat",
    });
  };

  const runtime = createChatMemoryRuntime({
    getSession,
    rewrite: async (request) => {
      const session = getSession();
      if (!session) throw new Error("MEMORY_LOCKED");
      return rewriteChatMemory(session, request);
    },
    consolidateDirect: async ({ messages, reason, signal }) => {
      if (!current() || !messages.length) return false;
      const wiki = await resolveSharedWiki({ initializeIfNeeded: false });
      if (!wiki || !current()) return false;
      const { SharedWikiOwnerMigrator } = await import("@/lib/files/wiki");
      const [cp, mig] = await Promise.all([
        wiki.readCaptureCheckpoint(signal).catch(() => null),
        new SharedWikiOwnerMigrator(wiki).getMigrationStatus(signal).catch(() => null),
      ]);
      if (mig?.state !== "wiki_primary") {
        return false;
      }
      if (!cp?.capture_opt_in && reason !== "remember") {
        return false;
      }
      const session = getSession();
      if (!session) return false;

      const pages = await wiki.listPages(undefined, signal).catch(() => []);
      const wikiSections: string[] = [];
      for (const summary of pages.slice(0, 24)) {
        const page = await wiki
          .readPage(summary.page_id, { requireSettled: true }, signal)
          .catch(() => null);
        if (!page) continue;
        const activeClaims = page.claims
          .filter((c) => c.status === "active")
          .map((c) => `- ${c.statement}`);
        if (activeClaims.length > 0) {
          wikiSections.push(`# ${page.title}\n${activeClaims.join("\n")}`);
        }
      }
      const currentWikiMarkdown = wikiSections.join("\n\n");
      const proposed = await rewriteChatMemory(session, {
        currentMarkdown: currentWikiMarkdown,
        messages: [...messages],
        maxTokens: 24_000,
        signal,
      });
      if (!current()) return false;

      await captureMessagesIntoSharedWiki(wiki, messages, {
        proposedMarkdown: proposed.markdown,
        previousMarkdown: currentWikiMarkdown,
        explicitOwnerSave: reason === "remember",
        signal,
      });
      return true;
    },
    onConsolidated: async ({ messages, markdown, previousMarkdown, reason }) => {
      if (!current() || !messages.length) return;
      if (await ownerContentIsPrivate()) {
        await syncPrivatePodWikiAndProjections({ markdown, reason });
        return;
      }
      const wiki = await resolveSharedWiki({
        initializeIfNeeded: reason === "remember",
      });
      if (!wiki || !current()) return;
      if (reason !== "remember") {
        const cp = await wiki.readCaptureCheckpoint().catch(() => null);
        if (!cp?.capture_opt_in) return;
      }
      await captureMessagesIntoSharedWiki(wiki, messages, {
        proposedMarkdown: markdown,
        previousMarkdown,
        explicitOwnerSave: reason === "remember",
      });
    },
    onWithdrawn: async ({ conversationId }) => {
      if (!current() || !conversationId) return;
      const wiki = await resolveSharedWiki();
      if (!wiki || !current()) return;
      const {
        SharedWikiKnowledgeWriter,
        SharedWikiProjectionEngine,
      } = await import("@/lib/files/wiki");
      const { retractStaleWikiProjectionsFromPkm } = await import(
        "@/lib/files/wiki/pkm-projection-sync"
      );

      const writer = new SharedWikiKnowledgeWriter(wiki);
      await writer.withdrawCapture({ conversationId });
      const projections = new SharedWikiProjectionEngine(wiki);
      const pages = await wiki.listPages();
      const allStaled = [];
      for (const p of pages) {
        const staled = await projections.syncPageLifecycle(p.page_id);
        for (const r of staled) {
          allStaled.push({
            receiptId: r.receipt_id,
            domain: r.domain,
            jsonPath: r.json_path,
            pageId: r.page_id,
            pageRevision: r.page_revision,
            claimId: r.claim_id,
            sourceRevision: r.source_revision,
          });
        }
      }
      if (allStaled.length > 0 && current()) {
        await retractStaleWikiProjectionsFromPkm(wiki.access, allStaled);
      }
    },
  });

  const cleanups: Array<() => void> = [];
  const entry: OwnerRuntime = {
    userId: input.userId,
    epoch: input.vaultEpoch,
    token: input.token,
    vaultKey: input.vaultKey,
    runtime,
    readToken: input.readToken,
    dispose: () => {
      runtime.clear();
      entry.readToken = () => null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (active === entry) active = null;
    },
  };
  active = entry;
  const invalidate = () => {
    if (!current()) entry.dispose();
  };
  cleanups.push(
    subscribeVaultSessionEpoch(invalidate),
    subscribeAuthSessionGeneration(invalidate),
    subscribeDurableOwnerReset((owner) => {
      if (owner === input.userId) entry.dispose();
    }),
  );
  return runtime;
}
