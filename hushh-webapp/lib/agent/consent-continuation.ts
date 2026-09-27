"use client";

// In-memory bookkeeping for information requests this tab sent from One chat
// and is waiting on. It holds identifiers only (owner, bundle, conversation,
// the other person's public reference and display name), never shared values,
// and it is never written to storage: a cold start finds the conversation again
// through the person's own sealed history.

import {
  CONSENT_OUTCOME_LABELS,
  formatSharedInformationForAgent,
  openGrantedPersonInformation,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import type { AgentChatConsentContinuation } from "@/lib/services/agent-chat-client";

export type SentInformationRequest = {
  ownerId: string;
  bundleId: string;
  conversationId: string;
  subjectRef: string;
  personName: string;
};

const waiting = new Map<string, SentInformationRequest>();
const claimed = new Set<string>();
const listeners = new Set<() => void>();

function keyOf(ownerId: string, bundleId: string): string {
  return `${ownerId}:${bundleId.toLowerCase()}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** The chat card registers a request it shows as waiting on the other person. */
export function watchSentInformationRequest(request: SentInformationRequest): void {
  if (!request.ownerId || !request.bundleId || !request.conversationId) return;
  const key = keyOf(request.ownerId, request.bundleId);
  if (claimed.has(key)) return;
  waiting.set(key, { ...request, bundleId: request.bundleId.toLowerCase() });
  emit();
}

export function unwatchSentInformationRequest(ownerId: string, bundleId: string): void {
  if (waiting.delete(keyOf(ownerId, bundleId))) emit();
}

export function listSentInformationRequests(ownerId: string | null | undefined): SentInformationRequest[] {
  if (!ownerId) return [];
  return [...waiting.values()].filter((request) => request.ownerId === ownerId);
}

export function sentInformationRequest(
  ownerId: string,
  bundleId: string,
): SentInformationRequest | null {
  return waiting.get(keyOf(ownerId, bundleId)) ?? null;
}

export function subscribeSentInformationRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const armed = new Set<string>();
const mountedCards = new Map<string, number>();

/**
 * A chat card for this request is on screen and will continue it in place.
 * Returns the release for unmount.
 */
export function mountInformationRequestCard(ownerId: string, bundleId: string): () => void {
  const key = keyOf(ownerId, bundleId);
  mountedCards.set(key, (mountedCards.get(key) ?? 0) + 1);
  return () => {
    const count = (mountedCards.get(key) ?? 1) - 1;
    if (count <= 0) mountedCards.delete(key);
    else mountedCards.set(key, count);
  };
}

export function isInformationRequestCardMounted(ownerId: string, bundleId: string): boolean {
  return (mountedCards.get(keyOf(ownerId, bundleId)) ?? 0) > 0;
}

/** The person opened this answer from its notice: its chat may continue it. */
export function armConsentContinuation(ownerId: string, bundleId: string): void {
  armed.add(keyOf(ownerId, bundleId));
}

/** Waiting in this tab, or opened from its notice. Anything else stays quiet. */
export function isConsentContinuationArmed(ownerId: string, bundleId: string): boolean {
  const key = keyOf(ownerId, bundleId);
  return waiting.has(key) || armed.has(key);
}

/**
 * Exactly one surface in this tab continues a given answer. The server also
 * refuses a second follow-up for the same bundle in the same conversation.
 */
export function claimConsentContinuation(ownerId: string, bundleId: string): boolean {
  const key = keyOf(ownerId, bundleId);
  if (claimed.has(key)) return false;
  claimed.add(key);
  armed.delete(key);
  if (waiting.delete(key)) emit();
  return true;
}

/** A continuation that failed before the server admitted it may be retried. */
export function releaseConsentContinuation(ownerId: string, bundleId: string): void {
  claimed.delete(keyOf(ownerId, bundleId));
}

export function clearSentInformationRequests(keepOwnerId?: string | null): void {
  for (const [key, request] of waiting) {
    if (request.ownerId !== keepOwnerId) waiting.delete(key);
  }
  for (const set of [claimed, armed]) {
    for (const key of set) {
      if (!keepOwnerId || !key.startsWith(`${keepOwnerId}:`)) set.delete(key);
    }
  }
  emit();
}

/**
 * Build the follow-up turn's request. For an approval the shared information
 * is decrypted on this device and passed only as this turn's text.
 */
export async function prepareConsentContinuation(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  bundleId: string;
  subjectRef: string;
  outcome: ConsentOutcome;
  domainFor?: (requestId: string) => string | null | undefined;
  isCurrent?: () => boolean;
}): Promise<{ message: string; continuation: AgentChatConsentContinuation } | null> {
  const message = CONSENT_OUTCOME_LABELS[input.outcome];
  if (input.outcome !== "granted") {
    return { message, continuation: { bundleId: input.bundleId, outcome: input.outcome } };
  }
  const opened = await openGrantedPersonInformation(input);
  if (!opened) return null;
  const sharedInformation = formatSharedInformationForAgent(opened.values);
  if (!sharedInformation) throw new Error("Nothing readable was shared.");
  return {
    message,
    continuation: { bundleId: input.bundleId, outcome: "granted", sharedInformation },
  };
}
