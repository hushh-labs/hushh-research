"use client";

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
import { buildConsentExportForScope, createConsentExportReadSession } from "@/lib/consent/export-builder";
import {
  hasAnyValue,
  projectApprovedAnswer,
  type ScopeProjection,
} from "@/lib/answers/answer-projection";
import { buildAnswerMemorySlice } from "@/lib/answers/answer-memory-slice";
import {
  approvedScopesBackedBySoul,
  projectApprovedSoulFacts,
  SCOPE_PATH_TO_LABEL,
} from "@/lib/answers/identity-soul-facts";
import { readLabelledSoulFacts, soulFactKey } from "@/lib/pkm/soul-labelled-facts";
import { loadMarkdownMemory } from "@/lib/pkm/markdown-memory";

/**
 * A name leaf inside the identity domain, which the account display name may
 * stand in for when nothing else answered it.
 *
 * Bounded to `attr.identity.` deliberately: a name leaf elsewhere -- an
 * employer's name, a school's name -- is not this person's name, and filling
 * it in from their profile would answer a different question than the one the
 * owner approved.
 */
const NAME_LEAVES = ["full_name", "legal_name", "name"] as const;

function isOwnNameScope(scope: string): boolean {
  if (!scope.startsWith("attr.identity.")) return false;
  const leaf = scope.split(".").pop() ?? "";
  return NAME_LEAVES.includes(leaf as (typeof NAME_LEAVES)[number]);
}
const isOwnPhotoScope = isAnswerProfilePhotoScope;
function scopeCoversPath(scope: string, path: string): boolean {
  return scope === `attr.identity.${path}` || scope === `attr.identity.${path.split(".").slice(0, -1).join(".")}.*`;
}
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
import { settleWithConcurrency } from "@/lib/consent/bounded-concurrency";

/**
 * Scope exports in flight at once while preparing one answer.
 *
 * Each builds an encrypted export on the owner's device, so this is the same
 * trade the grouped-Allow path already makes: a small bound, not everything.
 */
const ANSWER_SCOPE_READ_CONCURRENCY = 4;

export interface AnswerSweepParams {
  userId: string;
  /** The owner's vault key. Needed to decrypt their own PKM; never leaves the device. */
  vaultKey: string;
  vaultOwnerToken: string;
  firebaseIdToken: string;
  /** Explicit owner action may fulfil only the selected request. */
  requestId?: string;
  /**
   * The owner's own public identity, as the requester already sees it on the
   * profile they asked from. Passing null left every answer written from a
   * bag of fields with no one attached: the slice supports an account block
   * and the sweep never filled it, so a question like "what is your name"
   * had no name to answer from even with Identity information approved.
   *
   * Nothing here is new to the requester, and nothing here is PKM: it is the
   * account's display name, photo and email.
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
): Promise<{ payload: AnswerPayload; hasContent: boolean }> {
  const projections: ScopeProjection[] = [];
  const unavailableScopes: string[] = [];
  const sourceManifestRevisions: Record<string, number | null> = {};
  const readSession = createConsentExportReadSession({ ...params, scopes: work.approvedScopes });

  // Each scope remains its own consent projection. The read session deduplicates
  // domain ciphertext/manifest reads without exposing unapproved siblings.
  // What changes is the waiting. Awaiting them one after another made the
  // owner's preparation take the SUM of every scope's manifest read, blob
  // fetch and decrypt, on a phone, while they watched. A small bound runs
  // them together without building several encrypted exports at once.
  //
  // Order is restored by index, not arrival, so the document a requester is
  // shown does not depend on which read happened to finish first.
  const ordered: (ScopeProjection | null)[] = new Array(
    work.approvedScopes.length,
  ).fill(null);
  const failed: (string | null)[] = new Array(work.approvedScopes.length).fill(
    null,
  );
  if (!isVaultSessionEpochCurrent(epoch))
    throw new Error("Vault session changed");
  await settleWithConcurrency(
    work.approvedScopes.map((scope, index) => ({ scope, index })),
    ANSWER_SCOPE_READ_CONCURRENCY,
    async ({ scope, index }) => {
      // Re-checked per scope: a lock mid-sweep must stop the reads it can.
      if (!isVaultSessionEpochCurrent(epoch)) {
        failed[index] = scope;
        return;
      }
      try {
        const built = await buildConsentExportForScope({
          userId: params.userId,
          scope,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          readSession,
        });
        ordered[index] = {
          scope,
          payload: built.payload,
          contentRevision: built.sourceContentRevision ?? null,
        };
        sourceManifestRevisions[scope] = built.sourceManifestRevision ?? null;
      } catch {
        // A scope that cannot be exported is named, never silently omitted: a
        // partial answer that reads complete is the failure mode to avoid,
        // and the caller refuses to call this an absent answer.
        failed[index] = scope;
      }
    },
  );
  for (const projection of ordered) if (projection) projections.push(projection);
  for (const scope of failed) if (scope) unavailableScopes.push(scope);
  if (!isVaultSessionEpochCurrent(epoch))
    throw new Error("Vault session changed");

  // The identity intake records what the person states as labelled Soul
  // bullets, not as structured leaves, so an approved identity scope had no
  // leaf to project and came back empty even though the fact was sitting in
  // Profile Memory. Read that document once, and only for the scopes the
  // owner approved: the mapped labels are the only thing that can leave this
  // way, and the person's free prose cannot.
  const soulBackedScopes = approvedScopesBackedBySoul(work.approvedScopes);
  if (soulBackedScopes.length) {
    try {
      const memory = await loadMarkdownMemory({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        forceRefresh: true,
      });
      if (!memory || (memory.syncStatus && memory.syncStatus !== "synced")) throw new Error("Private memory readback pending");
      if (!isVaultSessionEpochCurrent(epoch))
        throw new Error("Vault session changed");
      const revision =
        typeof memory?.dataVersion === "number" ? memory.dataVersion : null;
      const facts = projectApprovedSoulFacts({
        approvedScopes: soulBackedScopes,
        markdown: memory?.markdown,
      });
      for (const scope of soulBackedScopes) {
        const prior = projections.filter(projection => projection.scope === scope);
        const original = prior.at(-1)?.payload as Record<string, unknown> | undefined;
        const domain = scope.split(".")[1]!;
        const payload = structuredClone(original?.[domain] ?? original ?? {}) as Record<string, unknown>;
        const overrides = facts.filter(fact => fact.scope === scope);
        const deleted = new Set(memory.deletedFactLabels ?? []);
        const removedPaths = SCOPE_PATH_TO_LABEL.filter(([, label]) => deleted.has(soulFactKey(label))).map(([path]) => path);
        if (deleted.has("date of birth") || (readLabelledSoulFacts(memory.markdown).has("date of birth") && !facts.some(fact => fact.path === "declared_age"))) removedPaths.push("identity_profile.declared_age");
        let changed = overrides.length > 0;
        for (const path of removedPaths) {
          const domain = path.startsWith("profile.") ? "professional" : "identity";
          if ((scope === `attr.${domain}.${path}` || scope === `attr.${domain}.${path.split(".").slice(0, -1).join(".")}.*`) && readPath(payload, path) !== undefined) {
            changed = true;
            setPath(payload, path, undefined);
          }
        }
        for (const fact of overrides) setPath(payload, fact.relativePath, fact.value);
        for (let index = projections.length - 1; index >= 0; index -= 1)
          if (projections[index]!.scope === scope) projections.splice(index, 1);
        projections.push({ scope, payload, contentRevision: changed ? revision : prior.at(-1)?.contentRevision ?? revision });
        if (changed || !prior.length) sourceManifestRevisions[scope] = null;
      }
      // These facts have no structured leaf at all, so the per-scope export
      // above always fails for them. That failure is the ABSENCE of a
      // counterpart, not an unreadable source -- and this document is their
      // authoritative source, so reading it successfully settles the question
      // either way:
      //
      //   * the fact is here  -> it was projected above, and the answer stages;
      //   * the fact is not   -> it is genuinely not recorded, which is an
      //                          answer ("Answer not found") and must not be
      //                          charged for.
      //
      // Clearing only the facts that were FOUND left a question nobody had
      // recorded an answer to stuck as unreadable: prepared, discarded and
      // prepared again for ever, never resolving either way. A failed read is
      // different and throws to the catch below, where every one of these
      // scopes stays unavailable and the request stays retryable.
      const settled = new Set(soulBackedScopes);
      for (let index = unavailableScopes.length - 1; index >= 0; index -= 1)
        if (settled.has(unavailableScopes[index]!)) unavailableScopes.splice(index, 1);
    } catch {
      // A Soul document that could not be read is not an absent fact. Naming
      // the scopes keeps the caller's rule: this request stays queued rather
      // than being delivered as "Answer not found".
      for (const scope of soulBackedScopes)
        if (!unavailableScopes.includes(scope)) unavailableScopes.push(scope);
    }
  }

  // Precedence for a name request: the legal name the person stated wins,
  // because they stated it. The account display name is the fallback, so a
  // name question is still answerable for an owner who never completed the
  // identity intake -- and it is the same value the requester already sees on
  // the profile. Only ever for an approved name scope.
  const accountName = (work.ownerIdentity ?? params.ownerIdentity)?.displayName?.trim();
  if (accountName) {
    // A scope whose read returned nothing is not answered. A confirmed-absent
    // source (an HTTP 404) still pushes an empty projection, and treating that
    // as an answer left a name request with no name in it.
    const answeredScopes = new Set(
      projections
        .filter((projection) => hasAnyValue(projection.payload))
        .map((projection) => projection.scope),
    );
    for (const scope of work.approvedScopes) {
      if (!isOwnNameScope(scope)) continue;
      if (answeredScopes.has(scope) || unavailableScopes.includes(scope)) continue;
      projections.push({
        scope,
        payload: (() => {
          // Nest under the scope's own path so it merges where the domain
          // expects it, rather than inventing a branch beside it.
          const segments = scope.split(".").slice(2);
          const payload: Record<string, unknown> = {};
          let branch = payload;
          for (const segment of segments.slice(0, -1))
            branch = (branch[segment] = {}) as Record<string, unknown>;
          branch[segments[segments.length - 1]!] = accountName;
          return payload;
        })(),
        // The account profile carries no PKM revision of its own.
        contentRevision: null,
      });
    }
  }

  const identity = work.ownerIdentity ?? params.ownerIdentity;
  const photoUrl = answerProfilePhotoUrl(identity?.photoUrl);
  for (const scope of work.approvedScopes.filter(isOwnPhotoScope)) {
    // This account field has no PKM leaf. Its authoritative profile read came
    // with the work item; no KYC or broad domain read is required.
    if (!identity) continue;
    for (let index = unavailableScopes.length - 1; index >= 0; index -= 1)
      if (unavailableScopes[index] === scope) unavailableScopes.splice(index, 1);
    const payload: Record<string, unknown> = {};
    if (photoUrl) setPath(payload, scope.split(".").slice(2).join("."), photoUrl);
    projections.push({ scope, payload, contentRevision: null });
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

  const composerValues = structuredClone(projected.byScope);
  for (const scope of work.approvedScopes.filter(isOwnPhotoScope)) {
    if (photoUrl) setPath(composerValues[scope] as Record<string, unknown>, scope.split(".").slice(2).join("."), answerPhotoReference(photoUrl));
  }

  // The approved slice of this person's living memory, in the same shape as
  // their own memory.md: who they are, then every approved value in full.
  const memorySlice = buildAnswerMemorySlice({
    byScope: composerValues,
    sourceRevisions: projected.sourceRevisions,
    sourceManifestRevisions,
    ownerIdentity: identity ? { ...identity, photoUrl: answerPhotoReference(photoUrl) } : null,
    builtAt: new Date().toISOString(),
  });

  // Have the answer written from that memory document. A failure is carried
  // through as 'projection', never dressed up as a written answer.
  let written: {
    answerMode: "agent" | "projection";
    answer: string | null;
    covers?: string[];
    gaps?: string[];
  } = {
    answerMode: "projection",
    answer: null,
  };
  if (!isVaultSessionEpochCurrent(epoch))
    throw new Error("Vault session changed");
  // Content is what the APPROVED scopes hold, and nothing else.
  //
  // Counting the account's own name, email or photo here made every owner who
  // has a profile name produce a "complete" answer to any question at all --
  // including one whose fact nobody ever recorded. "Answer not found" could
  // not happen, and the requester was charged for an answer that did not
  // exist. The account block is context ABOUT the person, carried in every
  // answer because the requester already sees it on the profile they asked
  // from; it is not an answer to what they asked.
  //
  // Where the account genuinely does answer the question -- a name request
  // with no stated legal name -- it is projected into that scope above and
  // counts through `projected` like any other fact.
  const missingRequiredIdentityFact = ["identity_profile.declared_age", "identity_profile.sex", "profile.age", "profile.sex"].some(path =>
    work.approvedScopes.some(scope => scopeCoversPath(scope, path) && !hasAnyValue(readPath((projected.byScope[scope] as Record<string, unknown> | undefined)?.identity ?? projected.byScope[scope], path))));
  const hasContent = projected.hasContent && !missingRequiredIdentityFact;
  if (firebaseIdToken && hasContent && !unavailableScopes.length && memorySlice.complete) {
    written = await AnswerRequestService.compose(
      firebaseIdToken,
      work.requestId,
      {
        // The memory document is the answer's source of truth; the per-scope
        // values travel beside it so the gene can cite exact figures.
        memory: memorySlice.markdown,
        values: composerValues,
      },
    ).catch(() => ({ answerMode: "projection" as const, answer: null }));
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
      ...(work.approvedScopes.some(isOwnPhotoScope) && photoUrl ? { ownerIdentity: { displayName: identity?.displayName ?? null, photoUrl } } : {}),
    },
    hasContent,
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
  epoch = snapshotVaultSessionEpoch(),
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
      const { payload, hasContent } = await buildAnswerPayload(
        work,
        params,
        params.firebaseIdToken,
        epoch,
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
      if (hasContent && (payload.answerMode !== "agent" || !payload.answer?.trim())) {
        result.retry += 1;
        continue;
      }

      if (!isVaultSessionEpochCurrent(epoch)) break;
      const envelope = await encryptSliceForRecipient({
        payload,
        recipientPublicKeyJwk: work.recipientKey.publicKeyJwk,
        recipientKeyId: work.recipientKey.keyId,
        metadata: { kind: "pkm_answer", requestId: work.requestId },
      });
      if (!isVaultSessionEpochCurrent(epoch)) break;
      await AnswerRequestService.deliver(
        params.firebaseIdToken,
        work.requestId,
        {
          envelope,
          sourceRevisions: payload.sourceRevisions,
          hasContent,
        },
      );
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
