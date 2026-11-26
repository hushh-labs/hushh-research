import { encryptLocationForRecipient } from "./encryption";
import { OneLocationService } from "./service";
import { isShareReadyRecipient, resolveEffectiveShareRecipients } from "./share-recipient-selection";
import type { OneLocationEncryptedEnvelope, OneLocationRecipient, PlainLocationPoint } from "./types";

export type PrivateCheckInResult = {
  succeededRecipientIds: string[];
  failedRecipientIds: string[];
};

export type PrivateCheckInRequest = {
  commandDirectiveId?: string;
  /** Consented owner snapshot from the draft, including Circle recipients. */
  recipientSnapshots?: OneLocationRecipient[];
  recipientIds: string[];
  durationHours: string;
  message?: string;
  point: PlainLocationPoint;
  clientOperationId: string;
  commandOperationId?: string;
  commandSignal?: AbortSignal;
  commandOwner?: string;
  confirmedAt: string;
  /** Named-Circle provenance when the check-in was targeted at a Circle. */
  sourceCircleId?: string | null;
};

function reviewIsFresh(point: PlainLocationPoint, reviewedAt: string, now: number) {
  const captured = Date.parse(point.capturedAt);
  const reviewed = Date.parse(reviewedAt);
  return Number.isFinite(captured) && Number.isFinite(reviewed) && reviewed <= now + 30_000 &&
    captured <= reviewed + 30_000 && reviewed - captured <= 60_000 && now - reviewed <= 10 * 60_000;
}

/** Execute a confirmed private check-in. The caller owns the review and its lifetime. */
export async function executePrivateCheckIn(input: {
  ownerId: string;
  token: string;
  request: PrivateCheckInRequest;
  recipients: readonly OneLocationRecipient[];
  envelopeCache: Map<string, OneLocationEncryptedEnvelope>;
  isCurrent: () => boolean;
}): Promise<PrivateCheckInResult> {
  const { ownerId, token, request, recipients, envelopeCache } = input;
  const current = () => input.isCurrent() && !request.commandSignal?.aborted &&
    (!request.commandOperationId || request.commandOwner === ownerId);
  const recipientIds = [...new Set(request.recipientIds)];
  const succeededRecipientIds: string[] = [];
  const outcome = () => ({ succeededRecipientIds, failedRecipientIds: recipientIds.filter((id) => !succeededRecipientIds.includes(id)) });
  if (!current()) return outcome();

  const selected = resolveEffectiveShareRecipients(recipients, recipientIds).filter(isShareReadyRecipient);
  if (!selected.length || selected.length !== recipientIds.length) {
    throw new Error("Select at least one trusted contact who is ready to receive your location.");
  }
  if (!reviewIsFresh(request.point, request.confirmedAt, Date.now()) ||
      !Number.isFinite(request.point.latitude) || Math.abs(request.point.latitude) > 90 ||
      !Number.isFinite(request.point.longitude) || Math.abs(request.point.longitude) > 180) {
    throw new Error("Refresh and review your location before sharing it.");
  }

  const message = request.message?.trim().slice(0, 160);
  const prefix = `${ownerId}:${request.clientOperationId}:`;
  for (const key of envelopeCache.keys()) {
    if (!key.startsWith(prefix)) envelopeCache.delete(key);
  }
  const prepared = await Promise.all(selected.map(async (recipient) => {
    const key = `${prefix}${recipient.userId}:${recipient.keyId}`;
    const cached = envelopeCache.get(key);
    const envelope = cached ?? await encryptLocationForRecipient({
      point: { ...request.point, ...(message ? { checkIn: { message } } : {}) },
      recipientPublicKeyJwk: recipient.publicKeyJwk, recipientKeyId: recipient.keyId,
    });
    // Reuse the ciphertext after a lost response. The server binds the operation to it.
    if (!cached && current()) envelopeCache.set(key, envelope);
    return { recipient, envelope, key };
  }));

  for (const { recipient, envelope, key } of prepared) {
    if (!current()) break;
    try {
      await OneLocationService.createGrantWithEnvelope({
        vaultOwnerToken: token, recipientUserId: recipient.userId, recipientKeyId: recipient.keyId,
        durationHours: Number(request.durationHours) || 1, clientOperationId: request.clientOperationId,
        commandOperationId: request.commandOperationId, commandDirectiveId: request.commandDirectiveId,
        confirmedAt: request.confirmedAt, envelope, reason: "check_in", shareKind: "check_in",
        sourceCircleId: request.sourceCircleId ?? null, isEffectCurrent: current,
      });
      succeededRecipientIds.push(recipient.userId);
      if (current()) envelopeCache.delete(key);
    } catch {
      // Keep the same envelope available if this recipient is retried.
    }
  }
  return outcome();
}

/** Client-only draft. Never include this object in server preparation or slots. */
export type PrivateCheckInDraft = {
  kind: "private_check_in";
  owner: string;
  salt: string;
  point: PlainLocationPoint;
  note: string;
  reviewedAt: string;
  recipientIds: string[];
  recipientKeys: Record<string, string | null>;
  duration: string;
  sourceCircleId: string | null;
};

export function readPrivateCheckInDraft(
  value: unknown,
  owner: string,
  now = Date.now(),
): PrivateCheckInDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as PrivateCheckInDraft;
  const point = draft.point;
  if (
    draft.kind !== "private_check_in" ||
    draft.owner !== owner ||
    typeof draft.salt !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.salt) ||
    !point ||
    typeof point !== "object" ||
    !Number.isFinite(point.latitude) ||
    Math.abs(point.latitude) > 90 ||
    !Number.isFinite(point.longitude) ||
    Math.abs(point.longitude) > 180 ||
    !["web", "ios", "android", "native", "unknown"].includes(
      point.sourcePlatform,
    ) ||
    (point.accuracyM != null &&
      (!Number.isFinite(point.accuracyM) || point.accuracyM < 0)) ||
    typeof draft.note !== "string" ||
    draft.note.length > 500 ||
    !Array.isArray(draft.recipientIds) ||
    !draft.recipientIds.length ||
    draft.recipientIds.length > 5000 ||
    draft.recipientIds.some(
      (id) => typeof id !== "string" || !id || id.length > 160,
    ) ||
    new Set(draft.recipientIds).size !== draft.recipientIds.length ||
    !draft.recipientKeys ||
    typeof draft.recipientKeys !== "object" ||
    draft.recipientIds.some(
      (id) =>
        typeof draft.recipientKeys[id] !== "string" &&
        draft.recipientKeys[id] !== null,
    ) ||
    typeof draft.duration !== "string" ||
    !Number.isFinite(Number(draft.duration)) ||
    Number(draft.duration) <= 0 ||
    Number(draft.duration) > 24 ||
    (draft.sourceCircleId !== null && typeof draft.sourceCircleId !== "string")
  )
    return null;
  if (!reviewIsFresh(point, draft.reviewedAt, now)) return null;
  return draft;
}

/** Only this salted change detector may leave the client before encryption. */
export async function privateCheckInDigest(
  draft: Pick<PrivateCheckInDraft, "salt" | "point" | "note">,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([draft.salt, draft.point, draft.note]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
