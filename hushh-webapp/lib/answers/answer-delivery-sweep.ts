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
 * SCOPE ISOLATION. Each approved scope is resolved individually through
 * `buildConsentExportForScope`, which walks the domain manifest to the exact
 * approved paths. Reading the whole domain and filtering afterwards would make
 * one approved field expose every sibling field beside it, so the domain is
 * never read as a unit here. `projectApprovedAnswer` then drops anything that
 * was not approved and applies the requested period.
 *
 * Trust boundary: the server is a blind relay. Everything below runs on the
 * owner's device, and only ciphertext is posted back.
 */

import { AnswerRequestService, type AnswerableWork } from "@/lib/services/answer-request-service";
import { encryptSliceForRecipient } from "@/lib/one-marketplace/encryption";
import { buildConsentExportForScope } from "@/lib/consent/export-builder";
import {
  projectApprovedAnswer,
  type ScopeProjection,
} from "@/lib/answers/answer-projection";
import { buildAnswerMemorySlice } from "@/lib/answers/answer-memory-slice";

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

export interface AnswerPayload {
  version: 1;
  question: string;
  /**
   * 'agent' means the answer field was written by the answer gene from the
   * approved projection. 'projection' means it was not, and `answer` is null:
   * the requester receives the approved information itself, labelled as such.
   * A projection is never presented as a written answer.
   */
  answerMode: "agent" | "projection";
  answer: string | null;
  covers: string[];
  gaps: string[];
  period: { start: string; end: string } | null;
  approvedScopes: string[];
  /** The approved projections themselves, keyed by scope. Supporting evidence. */
  approvedInformation: Record<string, unknown>;
  /**
   * The person's own memory document, sliced to exactly the approved scopes
   * and dates, with their name, initial and photo. This is what the answer is
   * written from -- not a file fetch.
   */
  memory: string;
  /** False when a section of that memory could not be read or was truncated. */
  memoryComplete: boolean;
  sourceRevisions: Record<string, number | null>;
  excludedByPeriod: number;
  /** Scopes that yielded nothing, so a partial answer cannot read as complete. */
  unavailableScopes: string[];
  builtAt: string;
}

/**
 * Build one question's answer from exactly its approved scopes.
 *
 * Exported for the scope-isolation regression: it must be provable that an
 * approved field cannot surface a sibling in the same domain.
 */
export async function buildAnswerPayload(
  work: AnswerableWork,
  params: Pick<AnswerSweepParams, "userId" | "vaultKey" | "vaultOwnerToken">,
  firebaseIdToken?: string,
): Promise<{ payload: AnswerPayload; hasContent: boolean }> {
  const projections: ScopeProjection[] = [];
  const unavailableScopes: string[] = [];

  for (const scope of work.approvedScopes) {
    try {
      const built = await buildConsentExportForScope({
        userId: params.userId,
        scope,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      projections.push({
        scope,
        payload: built.payload,
        contentRevision: built.sourceContentRevision ?? null,
      });
    } catch {
      // A scope that cannot be exported is named, never silently omitted: a
      // partial answer that reads complete is the failure mode to avoid.
      unavailableScopes.push(scope);
    }
  }

  const period =
    work.periodStart && work.periodEnd
      ? { start: work.periodStart, end: work.periodEnd }
      : null;

  const projected = projectApprovedAnswer({
    approvedScopes: work.approvedScopes,
    projections,
    period,
  });

  // The approved slice of this person's living memory, in the same shape as
  // their own memory.md: who they are, then every approved value in full.
  const memorySlice = buildAnswerMemorySlice({
    byScope: projected.byScope,
    sourceRevisions: projected.sourceRevisions,
    ownerIdentity: work.ownerIdentity ?? null,
    builtAt: new Date().toISOString(),
  });

  // Have the answer written from that memory document. A failure is carried
  // through as 'projection', never dressed up as a written answer.
  let written: { answerMode: "agent" | "projection"; answer: string | null; covers?: string[]; gaps?: string[] } = {
    answerMode: "projection",
    answer: null,
  };
  if (firebaseIdToken && projected.hasContent) {
    written = await AnswerRequestService.compose(firebaseIdToken, work.requestId, {
      // The memory document is the answer's source of truth; the per-scope
      // values travel beside it so the gene can cite exact figures.
      memory: memorySlice.markdown,
      values: projected.byScope,
    }).catch(() => ({ answerMode: "projection" as const, answer: null }));
  }

  return {
    payload: {
      version: 1,
      question: work.question,
      answerMode: written.answerMode,
      answer: written.answer,
      covers: written.covers ?? [],
      gaps: written.gaps ?? [],
      period,
      approvedScopes: [...work.approvedScopes],
      approvedInformation: projected.byScope,
      memory: memorySlice.markdown,
      memoryComplete: memorySlice.complete,
      sourceRevisions: projected.sourceRevisions,
      excludedByPeriod: projected.excludedByPeriod,
      unavailableScopes,
      builtAt: new Date().toISOString(),
    },
    hasContent: projected.hasContent,
  };
}

/**
 * Deliver every paid, approved, undelivered answer this owner owes.
 *
 * Each request is independent: one failure never blocks the rest, because a
 * single unreadable scope should not strand another person's paid answer.
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
      const { payload, hasContent } = await buildAnswerPayload(
        work,
        params,
        params.firebaseIdToken,
      );
      const envelope = await encryptSliceForRecipient({
        payload,
        recipientPublicKeyJwk: work.recipientKey.publicKeyJwk,
        recipientKeyId: work.recipientKey.keyId,
        metadata: { kind: "pkm_answer", requestId: work.requestId },
      });
      await AnswerRequestService.deliver(params.firebaseIdToken, work.requestId, {
        envelope,
        sourceRevisions: payload.sourceRevisions,
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
