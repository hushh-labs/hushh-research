"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { DEFAULT_MAX_FIX_AGE_MS, publishPointToGrants } from "@/lib/location/publisher";
import { activeOwnerGrants } from "@/lib/location/sharing-state";
import { OwnerOperationGate, stopSosShares } from "./command-sos";
import { encryptLocationForRecipient } from "./encryption";
import { LocationBus } from "./location-bus";
import { isSmsTriggeredGrant } from "./notifications";
import { OneLocationService } from "./service";
import { clearSosIncident, loadSosIncident, mergeSosGrantIds, reconcileSosIncident, saveSosIncident, type SosIncident } from "./sos-incident";
import { createSosSendIntent, isSosShareReadyRecipient, runSosPanic, SosPanicError, type SosDeliveryOutcome } from "./sos-trigger";
import type { OneLocationGrant, OneLocationRecipient, PlainLocationPoint } from "./types";

type OwnerSession = {
  ownerId: string;
  token: string;
  isCurrent?: () => boolean;
};

export type ChatSosReview = {
  ownerId: string;
  generation: number;
  contactUserIds: string[];
  recipients: OneLocationRecipient[];
  activeGrants: OneLocationGrant[];
  incident: SosIncident | null;
};

export type ChatSosPublication = {
  incident: SosIncident;
  delivery: SosDeliveryOutcome[];
  skippedNotReady: OneLocationRecipient[];
  unavailableContactCount: number;
  error?: string;
};

export type ChatSosDelivery = ChatSosPublication & {
  emailed: number;
  withoutEmail: string[];
  emailError?: string;
};

const operations = new OwnerOperationGate();
const pendingEmails = new Map<string, symbol>();

function currentOwner(session: OwnerSession, generation = LocationBus.getAccountGeneration()) {
  return () => generation === LocationBus.getAccountGeneration() && (session.isCurrent?.() ?? true);
}

function requireCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("The Location session changed. Open Save My Soul again.");
}

async function readActiveAlert({ ownerId, token }: OwnerSession) {
  const stateRequestedAt = Date.now();
  const state = await OneLocationService.getState(token);
  const activeGrants = activeOwnerGrants(state).filter((grant) =>
    grant.ownerUserId === ownerId && isSmsTriggeredGrant(grant));
  const incident = reconcileSosIncident(
    loadSosIncident(ownerId), activeGrants.map((grant) => grant.id), stateRequestedAt,
  );
  return { activeGrants, incident };
}

export async function loadChatSosActiveReview(session: OwnerSession): Promise<ChatSosReview> {
  const generation = LocationBus.getAccountGeneration();
  const isCurrent = currentOwner(session, generation);
  const alert = await readActiveAlert(session);
  requireCurrent(isCurrent);
  return { ownerId: session.ownerId, generation, contactUserIds: [], recipients: [], ...alert };
}

export async function loadChatSosReview(session: OwnerSession): Promise<ChatSosReview> {
  const [review, roster] = await Promise.all([
    loadChatSosActiveReview(session),
    OneLocationService.getSmsRecipientRoster(session.token),
  ]);
  requireCurrent(currentOwner(session, review.generation));
  return { ...review, contactUserIds: roster.smsContactUserIds, recipients: roster.recipients };
}

function alertGrantIds(review: Pick<ChatSosReview, "incident" | "activeGrants">) {
  return mergeSosGrantIds(review.incident, review.activeGrants.map((grant) => grant.id));
}

function sameSet(left: readonly string[], right: readonly string[]) {
  const expected = new Set(left);
  return expected.size === new Set(right).size && right.every((value) => expected.has(value));
}

function assertMeasuredPoint(point: PlainLocationPoint) {
  const age = Date.now() - Date.parse(point.capturedAt);
  if (!Number.isFinite(age) || Math.abs(age) > DEFAULT_MAX_FIX_AGE_MS ||
      !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) {
    throw new Error("Couldn’t get a recent location. Try again.");
  }
}

/** Called only after the owner confirms the named audience in the UI. */
export async function sendChatSos(session: OwnerSession & {
  review: ChatSosReview;
  note?: string | null;
  onPublished?: (publication: ChatSosPublication) => void;
}): Promise<ChatSosDelivery> {
  const { ownerId, token, review, note } = session;
  if (review.ownerId !== ownerId) throw new Error("Review your own emergency contacts first.");
  if (alertGrantIds(review).length) throw new Error("Save My Soul is already active.");
  const reviewedReady = review.recipients.filter(isSosShareReadyRecipient);
  if (!reviewedReady.length) throw new Error("No emergency contacts are ready to receive an alert.");
  const isCurrent = currentOwner(session, review.generation);
  requireCurrent(isCurrent);
  const operation = operations.begin(ownerId);
  if (!operation) throw new Error("An SMS operation is still finishing. Review its result first.");
  const sendIntent = createSosSendIntent();
  const canSend = () => isCurrent() && sendIntent.isCurrent();
  try {
    const point = await OneLocationService.captureCurrentPosition({ fresh: true, requireMeasurement: true, fastNetworkFallback: true });
    requireCurrent(isCurrent);
    const fresh = await loadChatSosReview({ ownerId, token, isCurrent });
    if (alertGrantIds(fresh).length) throw new Error("Save My Soul is already active. Review the current alert here.");
    const recipients = fresh.recipients.filter(isSosShareReadyRecipient);
    const reviewedKeys = new Map(reviewedReady.map((person) => [person.userId, person.keyId]));
    if (!sameSet(review.contactUserIds, fresh.contactUserIds) || recipients.length !== reviewedKeys.size ||
        recipients.some((recipient) => reviewedKeys.get(recipient.userId) !== recipient.keyId)) {
      throw new Error("Your emergency contacts changed. Review the current list before sending.");
    }
    assertMeasuredPoint(point);

    let failure: string | undefined;
    const { delivery, ...incident } = await runSosPanic({
      vaultOwnerToken: token, ownerUserId: ownerId, recipients, point, note,
      isStale: () => !isCurrent(), sendIntent,
      publish: async (grant, recipient, measuredPoint) => {
        const published = await publishPointToGrants({
          point: measuredPoint, grants: [grant], recipientsByUserId: new Map([[recipient.userId, recipient]]),
          precision: "precise", sos: true, vaultOwnerToken: token,
          encrypt: encryptLocationForRecipient,
          store: (params) => OneLocationService.storeEnvelope({ ...params, isEffectCurrent: canSend }),
        });
        const outcome = published.published[0];
        if (!outcome) throw new Error("Couldn’t publish your location for one or more contacts.");
        return outcome.recipientAlerted;
      },
    }).catch((error: unknown) => {
      if (!(error instanceof SosPanicError) || !error.partialIncident) throw error;
      failure = error.message;
      return { ...error.partialIncident, delivery: error.delivery };
    });

    const publication = {
      incident,
      delivery: delivery.filter(Boolean),
      skippedNotReady: fresh.recipients.filter((recipient) => !isSosShareReadyRecipient(recipient)),
      unavailableContactCount: fresh.contactUserIds.length - fresh.recipients.length,
      ...(failure ? { error: failure } : {}),
    };
    const email = Symbol("sos-email");
    const storedForThisSend = loadSosIncident(ownerId)?.startedAt === incident.startedAt;
    pendingEmails.set(ownerId, email);
    operations.finish(ownerId, operation);
    try {
      CacheSyncService.onOneLocationStateMutated(ownerId);
      if (isCurrent()) session.onPublished?.(publication);
      const mayEmail = () => canSend() && pendingEmails.get(ownerId) === email &&
        (!storedForThisSend || loadSosIncident(ownerId)?.startedAt === incident.startedAt);
      const noEmail = { ...publication, emailed: 0, withoutEmail: [] };
      if (!mayEmail()) return noEmail;
      try {
        const mail = await OneLocationService.sendSosEmails({
          vaultOwnerToken: token, grantIds: incident.grantIds, note,
          latitude: point.latitude, longitude: point.longitude, accuracyM: point.accuracyM,
          capturedAt: point.capturedAt, isEffectCurrent: mayEmail,
        });
        return {
          ...publication, emailed: mail.emailed, withoutEmail: mail.withoutEmail,
          ...(mail.configured === false ? { emailError: "Email fallback was unavailable." } : {}),
        };
      } catch {
        return { ...noEmail, emailError: "Email fallback could not be verified." };
      }
    } finally {
      if (pendingEmails.get(ownerId) === email) pendingEmails.delete(ownerId);
    }
  } finally {
    operations.finish(ownerId, operation);
  }
}

export async function stopChatSos(session: OwnerSession & {
  review: ChatSosReview;
  signal?: AbortSignal;
}) {
  const { ownerId, token, review, signal } = session;
  if (review.ownerId !== ownerId) throw new Error("Review your active alert first.");
  const isCurrent = currentOwner(session, review.generation);
  requireCurrent(isCurrent);
  const operation = operations.begin(ownerId);
  if (!operation) throw new Error("An SMS operation is still finishing. Review its result first.");
  try {
    const current = await readActiveAlert(session);
    requireCurrent(isCurrent);
    const reviewed = new Set(alertGrantIds(review));
    const grantIds = alertGrantIds(current);
    if (grantIds.some((id) => !reviewed.has(id))) {
      throw new Error("Your active alert changed. Review it before stopping.");
    }
    if (signal?.aborted) return { revoked: [], unresolved: grantIds };
    pendingEmails.delete(ownerId);

    const result = await stopSosShares({ grantIds, signal, revoke: (grantId) => {
      requireCurrent(isCurrent);
      return OneLocationService.revokeGrant({ vaultOwnerToken: token, grantId });
    } });
    const stored = loadSosIncident(ownerId);
    if (isCurrent() && (!stored || stored.grantIds.every((id) => reviewed.has(id)))) {
      if (result.unresolved.length) {
        saveSosIncident({ ownerUserId: ownerId, startedAt: stored?.startedAt ?? new Date().toISOString(), grantIds: result.unresolved });
      } else if (stored) {
        clearSosIncident();
      }
    }
    if (grantIds.length) CacheSyncService.onOneLocationStateMutated(ownerId);
    return result;
  } finally {
    operations.finish(ownerId, operation);
  }
}
