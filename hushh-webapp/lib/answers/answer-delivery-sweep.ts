"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { answerProfilePhotoUrl, answerPhotoReference, isAnswerProfilePhotoScope } from "@/lib/answers/answer-profile-photo";

/**
 * Owner-side answer delivery sweep.
 *
 * The unlocked owner explicitly approves and prepares a readable answer,
 * then seals it for the requester before checkout. Verified payment releases
 * that staged ciphertext. Historical paid requests without a staged answer
 * still need manual owner preparation within their original refund deadline.
 *
 * This is not always-on operation: private reads and WebCrypto require the
 * owner's unlocked session. The reviewed runtime/key proposal remains in
 * docs/reference/architecture/living-memory-freshness-adr.md.
 *
 * SCOPE ISOLATION. Each approved scope is resolved individually through
 * `buildConsentExportForScope`, which walks the domain manifest to the exact
 * approved paths. Reading the whole domain and filtering afterwards would make
 * one approved field expose every sibling field beside it, so the domain is
 * never read as a unit here. `projectApprovedAnswer` then drops anything that
 * was not approved and applies the requested period.
 *
 * Trust boundary: reads and encryption run on the owner's device. The approved
 * projection is sent transiently to the composer and model provider under the
 * separately reviewed flag; delivery storage receives only ciphertext.
 */

import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import {
  AnswerRequestService,
  type AnswerableWork,
} from "@/lib/services/answer-request-service";
import { encryptSliceForRecipient } from "@/lib/one-marketplace/encryption";
import {
  hasAnyValue,
  projectApprovedAnswer,
} from "@/lib/answers/answer-projection";
import { buildAnswerMemorySlice } from "@/lib/answers/answer-memory-slice";
import { isOwnProfileNameScope } from "@/lib/pkm/identity-memory-facts";
import { retrieveApprovedMemoryScopes } from "@/lib/pkm/memory-scope-retrieval";
import { answerStageTiming } from "@/lib/answers/answer-stage-timing";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { AccountIdentityService } from "@/lib/services/account-identity-service";

function setPath(payload: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let branch = payload;
  for (const segment of segments.slice(0, -1)) {
    const current = branch[segment];
    branch = (branch[segment] = current && typeof current === "object" && !Array.isArray(current) ? current : {}) as Record<string, unknown>;
  }
  if (value === undefined) delete branch[segments.at(-1)!];
  else branch[segments.at(-1)!] = value;
}
function readPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  return current;
}
export interface AnswerSweepParams {
  userId: string;
  /** The owner's vault key. Needed to decrypt their own PKM; never leaves the device. */
  vaultKey: string;
  vaultOwnerToken: string;
  firebaseIdToken: string;
  /** Explicit owner action may fulfil only the selected request. */
  requestId?: string;
  /**
   * Existing account identity supplies only the exact approved name/photo
   * scopes. It never accompanies unrelated facts as general profile context.
   */
  ownerIdentity?: {
    displayName?: string | null;
    email?: string | null;
    photoUrl?: string | null;
  } | null;
}

export interface AnswerSweepResult {
  delivered: number;
  empty: number;
  skipped: number;
  /** Composition failed; left queued for the next explicit attempt, then refunded. */
  retry: number;
}

export interface AnswerPayload {
  version: 1;
  question: string;
  /**
   * Every successful delivery is Gemini composed. 'projection' with a null
   * answer is an internal retry/confirmed-missing result and is never sold.
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
   * and dates. Gemini receives only these approved facts and source metadata.
   */
  memory: string;
  /** False when a section of that memory could not be read or was truncated. */
  memoryComplete: boolean;
  sourceRevisions: Record<string, number | null>;
  excludedByPeriod: number;
  /** Scopes that yielded nothing, so a partial answer cannot read as complete. */
  unavailableScopes: string[];
  builtAt: string;
  /** Trusted account photo, shown only when its exact scope was approved. */
  ownerIdentity?: { displayName?: string | null; photoUrl?: string | null };
}

/**
 * Build one question's answer from exactly its approved scopes.
 *
 * Exported for the scope-isolation regression: it must be provable that an
 * approved field cannot surface a sibling in the same domain.
 */
export async function buildAnswerPayload(
  work: AnswerableWork,
  params: Pick<
    AnswerSweepParams,
    "userId" | "vaultKey" | "vaultOwnerToken" | "ownerIdentity"
  >,
  firebaseIdToken?: string,
  epoch = snapshotVaultSessionEpoch(),
  assertActive: () => void = () => {},
): Promise<{ payload: AnswerPayload; hasContent: boolean; compositionReceipt?: string; assertCurrent: () => Promise<void> }> {
  const memoryStarted = performance.now();
  assertActive();
  const retrieved = await retrieveApprovedMemoryScopes({
    assertActive,
    onRefreshTiming: started => answerStageTiming(work.requestId, "memory_refresh", started),
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    approvedScopes: work.approvedScopes,
    ownerIdentity: work.ownerIdentity ?? params.ownerIdentity,
    ...(firebaseIdToken ? { readOwnerIdentity: async () => {
      const identity = await AccountIdentityService.refreshIdentityForSession(params.userId, firebaseIdToken, { force: true });
      return identity ? { displayName: identity.display_name, photoUrl: identity.photo_url } : null;
    } } : {}),
  });
  if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed");
  assertActive();
  answerStageTiming(work.requestId, "memory_read", memoryStarted);
  const { projections, unavailableScopes, sourceManifestRevisions } = retrieved;

  const period =
    work.periodStart && work.periodEnd
      ? { start: work.periodStart, end: work.periodEnd }
      : null;

  const projected = projectApprovedAnswer({
    approvedScopes: work.approvedScopes,
    projections,
    period,
  });

  const photoScopes = work.approvedScopes.filter(isAnswerProfilePhotoScope);
  const photoUrl = photoScopes.map(scope => {
    const value = projected.byScope[scope] as Record<string, unknown> | undefined;
    return answerProfilePhotoUrl(readPath(value?.identity ?? value, scope.split(".").slice(2).join(".")));
  }).find(Boolean) ?? null;
  const approvedName = work.approvedScopes.filter(isOwnProfileNameScope).map(scope => {
    const value = projected.byScope[scope] as Record<string, unknown> | undefined;
    return readPath(value?.identity ?? value, scope.split(".").slice(2).join("."));
  }).find(value => typeof value === "string" && value.trim()) as string | undefined;
  const composerValues = structuredClone(projected.byScope);
  for (const scope of photoScopes) {
    if (photoUrl) setPath(composerValues[scope] as Record<string, unknown>, scope.split(".").slice(2).join("."), answerPhotoReference(photoUrl));
  }

  // The approved slice of this person's living memory, in the same shape as
  // their own memory.md, containing only approved values and source metadata.
  const memorySlice = buildAnswerMemorySlice({
    byScope: composerValues,
    sourceRevisions: projected.sourceRevisions,
    sourceManifestRevisions,
    builtAt: retrieved.builtAt,
  });

  // Have the answer written from that memory document. A failure is carried
  // through as 'projection', never dressed up as a written answer.
  let written: {
    answerMode: "agent" | "projection";
    answer: string | null;
    covers?: string[];
    gaps?: string[];
    compositionReceipt?: string;
  } = {
    answerMode: "projection",
    answer: null,
  };
  if (!isVaultSessionEpochCurrent(epoch))
    throw new Error("Vault session changed");
  // Profile context never supplies content for an unrelated approved fact.
  // Account name/photo count only when projected into their exact scopes.
  const missingApprovedFact = work.approvedScopes.some(scope => !hasAnyValue(projected.byScope[scope]));
  const hasContent = projected.hasContent && !missingApprovedFact;
  if (firebaseIdToken && hasContent && !unavailableScopes.length && retrieved.complete && memorySlice.complete) {
    assertActive();
    const composeStarted = performance.now();
    written = await AnswerRequestService.compose(
      firebaseIdToken,
      work.requestId,
      {
        // The memory document is the answer's source of truth; the per-scope
        // values travel beside it so the gene can cite exact figures.
        memory: memorySlice.markdown,
        values: composerValues,
        sourceFreshness: retrieved.sourceFreshness,
      },
    ).catch(() => ({ answerMode: "projection" as const, answer: null }));
    assertActive();
    answerStageTiming(work.requestId, "gemini_compose", composeStarted);
  }

  if (firebaseIdToken && retrieved.complete) await retrieved.assertCurrent();

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
      memoryComplete: retrieved.complete && memorySlice.complete,
      sourceRevisions: projected.sourceRevisions,
      excludedByPeriod: projected.excludedByPeriod,
      unavailableScopes,
      builtAt: new Date().toISOString(),
      ...(photoUrl ? { ownerIdentity: { displayName: approvedName ?? null, photoUrl } } : {}),
    },
    hasContent,
    compositionReceipt: written.compositionReceipt,
    assertCurrent: retrieved.assertCurrent,
  };
}

/**
 * Deliver every paid, approved, undelivered answer this owner owes.
 *
 * Each request is independent: one failure never blocks the rest, because a
 * single unreadable scope should not strand another person's paid answer.
 */
async function runAnswerDeliverySweepNow(
  params: AnswerSweepParams,
  epoch: number,
  assertActive: () => void,
): Promise<AnswerSweepResult> {
  const result: AnswerSweepResult = {
    delivered: 0,
    empty: 0,
    skipped: 0,
    retry: 0,
  };
  if (!params.vaultKey || !params.vaultOwnerToken || !params.firebaseIdToken)
    return result;

  let queue: AnswerableWork[] = [];
  try {
    queue = await AnswerRequestService.answerable(params.firebaseIdToken);
  } catch {
    return result;
  }

  for (const work of queue) {
    if (params.requestId && work.requestId !== params.requestId) continue;
    if (!isVaultSessionEpochCurrent(epoch)) break;
    try {
      const { payload, hasContent, compositionReceipt, assertCurrent } = await buildAnswerPayload(
        work,
        params,
        params.firebaseIdToken,
        epoch,
        assertActive,
      );

      // A question the owner's information CAN answer, but which the writer
      // failed to answer, is not finished work. Delivering the approved
      // material as `projection` would mark the request answered, pay the
      // owner, and hand the requester raw records instead of the answer they
      // bought. Leave it queued instead: the next explicit attempt retries, and if it
      // never succeeds the deadline sweep expires it and refunds in full.
      //
      // An empty answer is different and still delivers: there is genuinely
      // nothing to say, the delivery records that, and it refunds itself.
      // "Answer not found" is a claim about what this person's memory holds,
      // so it may only be made from a complete read. A scope that failed to
      // export -- locked vault, stale manifest, a network blip -- is not an
      // absent fact, and neither is a document that reports itself truncated.
      // Delivering empty here told the requester the answer does not exist,
      // refused their payment for good, and did it on evidence that was never
      // gathered. Leave it queued: the next attempt retries and the row keeps
      // saying the memory is still being checked.
      if (payload.unavailableScopes.length > 0 || !payload.memoryComplete) {
        result.retry += 1;
        continue;
      }

      // A question the owner's information CAN answer, but which the writer
      // failed to answer, is not finished work either.
      if (hasContent && (payload.answerMode !== "agent" || !payload.answer?.trim() || payload.gaps.length > 0 || !compositionReceipt)) {
        result.retry += 1;
        continue;
      }

      if (!isVaultSessionEpochCurrent(epoch)) break;
      assertActive();
      const stageStarted = performance.now();
      const envelope = await encryptSliceForRecipient({
        payload,
        recipientPublicKeyJwk: work.recipientKey.publicKeyJwk,
        recipientKeyId: work.recipientKey.keyId,
        metadata: { kind: "pkm_answer", requestId: work.requestId },
      });
      if (!isVaultSessionEpochCurrent(epoch)) break;
      await assertCurrent();
      assertActive();
      await AnswerRequestService.deliver(
        params.firebaseIdToken,
        work.requestId,
        {
          envelope,
          sourceRevisions: payload.sourceRevisions,
          hasContent,
          compositionReceipt,
        },
      );
      answerStageTiming(work.requestId, "encrypt_stage", stageStarted);
      CacheSyncService.onConsentMutated(params.userId);
      dispatchConsentStateChanged({ userId: params.userId, requestId: `answer_request:${work.requestId}` });
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

// All owner surfaces join the same preparation. The bounded UI wait withdraws
// permission for late reads/composition to advance to staging.
const preparations = new Map<string, Promise<AnswerSweepResult>>();
export function runAnswerDeliverySweep(params: AnswerSweepParams, epoch = snapshotVaultSessionEpoch()): Promise<AnswerSweepResult> {
  const key = `${params.userId}:${params.requestId ?? "all"}:${epoch}`;
  const existing = preparations.get(key);
  if (existing) return existing;
  let expired = false;
  const assertActive = () => {
    if (expired || !isVaultSessionEpochCurrent(epoch)) throw new Error("Preparation timed out or vault session changed. Retry preparation.");
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<AnswerSweepResult>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error("Preparation timed out. Keep memory unlocked and retry preparation.")); }, 60_000);
  });
  const operation = runAnswerDeliverySweepNow(params, epoch, assertActive);
  const bounded = Promise.race([operation, timeout]).finally(() => { clearTimeout(timer); });
  // Retain the join while the underlying operation unwinds; a timeout must
  // not start a competing writer or Gemini request.
  preparations.set(key, bounded);
  void operation.finally(() => { if (preparations.get(key) === bounded) preparations.delete(key); }).catch(() => {});
  return bounded;
}
