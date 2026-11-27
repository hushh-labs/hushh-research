import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { trackEvent } from "./client";
import type { EventPayloadMap, EventResult } from "./events";

/** One terminal observation per attempted operation; owner identity never enters its payload. */
function ownerOperation(emit: (result: EventResult) => void, userId?: string) {
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = snapshotVaultSessionEpoch();
  let completed = false;
  return (result: EventResult): void => {
    if (completed) return;
    completed = true;
    if (!owner || (userId !== undefined && owner.userId !== userId) ||
        !isValidatedAuthSessionOwnerCurrent(owner) || !isVaultSessionEpochCurrent(epoch)) return;
    emit(result);
  };
}

export function observeCareerOperation(userId: string, action: EventPayloadMap["one_career_action"]["action"]) {
  return ownerOperation(result => trackEvent("one_career_action", { action, result }), userId);
}

export function observeDocumentRequestOperation(action: EventPayloadMap["one_document_request_action"]["action"], userId?: string) {
  return ownerOperation(result => trackEvent("one_document_request_action", { action, result }), userId);
}
