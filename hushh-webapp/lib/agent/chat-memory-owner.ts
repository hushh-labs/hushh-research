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
import { createChatMemoryRuntime } from "./chat-memory-runtime";
import { rewriteChatMemory } from "./chat-memory-rewrite";

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

  const resolveSharedWiki = async () => {
    const session = getSession();
    if (!session || (await ownerContentIsPrivate())) return null;
    const { ensureActiveSharedWiki, peekActiveSharedWiki } = await import(
      "@/lib/files/wiki/active-shared-wiki"
    );
    const existing = peekActiveSharedWiki();
    if (existing) return existing;
    const ensured = ensureActiveSharedWiki({
      userId: session.userId,
      vaultKey: session.vaultKey,
      vaultOwnerToken: session.vaultOwnerToken,
      vaultEpoch: input.vaultEpoch,
      readToken: liveToken,
    });
    if (!ensured) return null;
    const initialized = await ensured.store.readyIfInitialized();
    return initialized ? ensured : null;
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
  ) => {
    const {
      SharedWikiKnowledgeWriter,
      SharedWikiProjectionEngine,
    } = await import("@/lib/files/wiki");
    const {
      classifyWikiClaimsForPkm,
      fetchProjectionSharingImpact,
      inspectPkmConflictsForProjection,
      materializeWikiReceiptToPkm,
    } = await import("@/lib/files/wiki/pkm-projection-sync");

    const writer = new SharedWikiKnowledgeWriter(wiki);
    const captured = await writer.captureEvents(
      messages.map((m) => ({
        conversationId: m.conversationId,
        eventId: m.id,
        role: m.role,
        content: m.content,
        consentDerived: m.consentDerived,
      })),
    );
    if (captured.status !== "saved" || captured.saved_page_ids.length === 0) {
      return;
    }

    const projections = new SharedWikiProjectionEngine(wiki);
    for (const pageId of captured.saved_page_ids) {
      await projections.syncPageLifecycle(pageId);
    }

    if (!current() || captured.saved_claim_ids.length === 0) return;
    const checkpoint = await wiki.readCaptureCheckpoint();
    const autoSaveIso = new Date(
      checkpoint.opt_in_updated_at || Date.now(),
    ).toISOString();

    const savedClaims: Array<{ pageId: string; claimId: string; statement: string }> = [];
    for (const pageId of captured.saved_page_ids) {
      const page = await wiki.readPage(pageId, { requireSettled: true }).catch(() => null);
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
          });
        }
      }
    }
    if (savedClaims.length === 0 || !current()) return;

    const classified = await classifyWikiClaimsForPkm(
      wiki.access,
      savedClaims.map((c) => c.statement),
    );
    for (const item of savedClaims) {
      if (!current()) return;
      const mapping = classified.find(
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

      const receipt = await projections.deriveProjection({
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
      });

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
            autoSaveEnabledAtIso: autoSaveIso,
            sharingImpactOverride: impact,
          },
        ).catch(() => ({ outcome: "requires_upgrade" as const }));

        if (outcome.outcome === "requires_upgrade" || outcome.outcome === "requires_confirmation") {
          await projections.deriveProjection({
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
          });
        }
      }
    }
  };

  const runtime = createChatMemoryRuntime({
    getSession,
    rewrite: async (request) => {
      const session = getSession();
      if (!session) throw new Error("MEMORY_LOCKED");
      return rewriteChatMemory(session, request);
    },
    consolidateDirect: async ({ messages, signal }) => {
      if (!current() || !messages.length) return false;
      const wiki = await resolveSharedWiki();
      if (!wiki || !current()) return false;
      const { SharedWikiOwnerMigrator } = await import("@/lib/files/wiki");
      const [cp, mig] = await Promise.all([
        wiki.readCaptureCheckpoint(signal).catch(() => null),
        new SharedWikiOwnerMigrator(wiki).getMigrationStatus(signal).catch(() => null),
      ]);
      if (!cp?.capture_opt_in || mig?.state !== "wiki_primary") {
        return false;
      }
      await captureMessagesIntoSharedWiki(wiki, messages);
      return true;
    },
    onConsolidated: async ({ messages }) => {
      if (!current() || !messages.length) return;
      const wiki = await resolveSharedWiki();
      if (!wiki || !current()) return;
      await captureMessagesIntoSharedWiki(wiki, messages);
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
