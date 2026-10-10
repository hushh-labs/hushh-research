"use client";

/**
 * Owner-side answer delivery sweep.
 *
 * This is the fulfilment half of a paid answer, and it exists for the same
 * reason the marketplace sweep does (`lib/one-marketplace/delivery-sweep.ts`):
 * the backend settles the payment but has no vault key, so it can only move a
 * request to `answering`. Producing the answer needs the owner's decrypted PKM
 * and WebCrypto, both of which exist only in an unlocked session on their
 * device.
 *
 * INTERIM, AND UNLOCK-DEPENDENT. This is not 24/7 operation. A paid, approved
 * question produces nothing until the owner next opens and unlocks the app.
 * The requester is told that before they pay, the deadline is quoted before
 * they pay, and a missed deadline refunds in full. The architectures that
 * could make this genuinely always-on, without escrowing a key to the backend,
 * are costed in docs/reference/architecture/living-memory-freshness-adr.md and
 * none of them is implemented. Do not describe this as the 24/7 feature.
 *
 * Trust boundary: the server is a blind relay. Everything below runs on the
 * owner's device, and only ciphertext is posted back.
 */

import { AnswerRequestService, type AnswerableWork } from "@/lib/services/answer-request-service";
import { encryptSliceForRecipient } from "@/lib/one-marketplace/encryption";
import { buildMemoryDocument } from "@/lib/pkm/memory-document";
import { buildPkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";

export interface AnswerSweepParams {
  userId: string;
  /** The owner's vault key. Needed to decrypt their own PKM; never leaves the device. */
  vaultKey: string;
  vaultOwnerToken: string;
  firebaseIdToken: string;
}

export interface AnswerSweepResult {
  delivered: number;
  empty: number;
  skipped: number;
}

/** The domain part of an `attr.<domain>[.<path>]` scope. */
function scopeDomain(scope: string): string {
  const parts = String(scope || "").split(".");
  return parts.length >= 2 ? (parts[1] ?? "") : "";
}

/**
 * Build the answer payload for one question from the approved scopes only.
 *
 * Scope isolation is enforced here by construction: the only domains read are
 * those derived from `approvedScopes`, so a domain the owner did not approve
 * is never decrypted, never rendered, and cannot reach the envelope.
 *
 * The document is built for the `agent` audience, which applies the stricter
 * packet exclusion plus the reserved-branch `send_to_model` rule, so
 * label-only and never branches are withheld even if a scope somehow named
 * one.
 */
async function buildAnswerPayload(
  work: AnswerableWork,
  params: AnswerSweepParams,
): Promise<{ payload: Record<string, unknown>; hasContent: boolean }> {
  const domains = [...new Set(work.approvedScopes.map(scopeDomain).filter(Boolean))];

  const sources: { domain: string; contentRevision: number | null; unavailableReason?: string }[] =
    [];
  const fullBlob: Record<string, unknown> = {};

  for (const domain of domains) {
    try {
      const snapshot = await PkmDomainResourceService.getStaleFirst({
        userId: params.userId,
        domain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      if (!snapshot?.data) {
        sources.push({ domain, contentRevision: null, unavailableReason: "no data" });
        continue;
      }
      fullBlob[domain] = snapshot.data;
      sources.push({ domain, contentRevision: snapshot.key.contentRevision });
    } catch {
      // An unreadable domain is reported, never silently dropped: a partial
      // answer that reads complete is the failure mode this guards against.
      sources.push({ domain, contentRevision: null, unavailableReason: "could not be read" });
    }
  }

  // `metadata: null` keeps the snapshot to exactly the domains read above;
  // the discovery index could otherwise name a domain that was not approved.
  const snapshot = buildPkmMemorySnapshot({ metadata: null, fullBlob });
  const document = buildMemoryDocument({
    snapshot,
    sources,
    audience: "agent",
    builtAt: new Date().toISOString(),
  });

  const revisions = Object.fromEntries(
    document.freshness.map((entry) => [entry.domain, entry.contentRevision]),
  );

  return {
    payload: {
      version: 1,
      question: work.question,
      period:
        work.periodStart && work.periodEnd
          ? { start: work.periodStart, end: work.periodEnd }
          : null,
      approvedScopes: work.approvedScopes,
      // The answer material, scoped to exactly what was approved and paid for.
      memory: document.markdown,
      // Honest freshness travels with the answer: the requester can see which
      // revision each section came from and whether any of it was unreadable.
      sourceRevisions: revisions,
      complete: document.complete,
    },
    // An answer with no readable section is an empty answer, which refunds.
    hasContent: document.freshness.some(
      (entry) => entry.status === "current" && entry.cardCount > 0,
    ),
  };
}

/**
 * Deliver every paid, approved, undelivered answer this owner owes.
 *
 * Each request is independent: one failure never blocks the rest, because a
 * single unreadable domain should not strand another person's paid answer.
 */
export async function runAnswerDeliverySweep(
  params: AnswerSweepParams,
): Promise<AnswerSweepResult> {
  const result: AnswerSweepResult = { delivered: 0, empty: 0, skipped: 0 };
  if (!params.vaultKey || !params.vaultOwnerToken || !params.firebaseIdToken) return result;

  let queue: AnswerableWork[] = [];
  try {
    queue = await AnswerRequestService.answerable(params.firebaseIdToken);
  } catch {
    return result;
  }

  for (const work of queue) {
    try {
      const { payload, hasContent } = await buildAnswerPayload(work, params);
      const envelope = await encryptSliceForRecipient({
        payload,
        recipientPublicKeyJwk: work.recipientKey.publicKeyJwk,
        recipientKeyId: work.recipientKey.keyId,
        metadata: { kind: "pkm_answer", requestId: work.requestId },
      });
      await AnswerRequestService.deliver(params.firebaseIdToken, work.requestId, {
        envelope,
        sourceRevisions: payload.sourceRevisions as Record<string, unknown>,
        hasContent,
      });
      if (hasContent) result.delivered += 1;
      else result.empty += 1;
    } catch {
      // Leave it queued. The backend's deadline sweep refunds if it never
      // succeeds, so a stuck answer costs the requester nothing.
      result.skipped += 1;
    }
  }
  return result;
}
