import type { User } from "firebase/auth";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { PhoneRecoveryService, type LinkedDeletionProof, type LinkedDeletionReceipt } from "@/lib/services/phone-recovery-service";

/** `recheck` reads back a sent but unconfirmed confirmation; it never sends it or its proof again. */
export type LinkedDeletionInput = { operationId: string; phoneNumber: string; testCode?: string; recheck?: boolean };
type RetainedProof = { token: string; userId: string; epoch: number } | null;
/** AuthProvider keeps identity authority; this module only sequences existing calls. */
export type LinkedDeletionPorts = {
  user: () => User | null;
  retained: () => RetainedProof;
  requireOwner: (uid: string, epoch: number) => void;
  releaseProof: () => void;
};

// The review stays usable only for these; every other refusal spent its operation
// (and, for real numbers, its SMS proof), so the person verifies the number again.
// PHONE_PROOF_SERVICE_UNAVAILABLE is raised while decoding the proof, before any write.
const RETRYABLE = new Set(["UAT_PHONE_TEST_INVALID_CODE", "PHONE_LINKED_DELETION_SUPPORT_REQUIRED",
  "PHONE_LINKED_DELETION_PREPARED", "PHONE_RECOVERY_LIMIT_REACHED", "PHONE_RECOVERY_UNAVAILABLE",
  "PHONE_LINKED_DELETION_VERIFICATION_UNAVAILABLE", "PHONE_TRANSFER_PROVIDER_UNAVAILABLE",
  "PHONE_PROOF_SERVICE_UNAVAILABLE"]);
const EXPIRED = new Set(["PHONE_LINKED_PROOF_REQUIRED", "PHONE_LINKED_DELETION_PROOF_REQUIRED", "PHONE_TRANSFER_STALE",
  "INVALID_PHONE_ID_TOKEN", "PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED", "PHONE_LINKED_DELETION_EXPIRED"]);
const MESSAGES: Record<string, string> = {
  UAT_PHONE_TEST_INVALID_CODE: "That code isn’t right. Check it and try again.",
  PHONE_LINKED_DELETION_ATTEMPTS_EXCEEDED: "Too many wrong codes. Verify this number again.",
  PHONE_LINKED_DELETION_PROOF_ALREADY_USED: "That code was already used. Verify this number again.",
  PHONE_RECOVERY_LIMIT_REACHED: "Too many attempts. Try again in a few minutes.",
  PHONE_LINKED_DELETION_STALE: "That account changed. Verify this number again.",
  PHONE_LINKED_ACCOUNT_CHANGED: "That number’s account changed. Verify this number again.",
  PHONE_LINKED_ACCOUNT_PROTECTED: "This account can’t be deleted here.",
  PHONE_LINKED_DELETION_RECOVERY_REQUIRED: "That account can only be deleted after signing in to it. Use a different number, or contact one@hushh.ai.",
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING: "That account has its own cloud setup. Delete it from that account.",
  ACCOUNT_DELETION_PAUSED: "Deletion is paused for a few minutes. Verify this number again to retry.",
  PHONE_TRANSFER_IN_PROGRESS: "A phone transfer is still finishing. Verify this number again in a moment.",
  PHONE_LINKED_DELETION_SUPPORT_REQUIRED: "We couldn’t confirm the deletion. Check again, or contact one@hushh.ai.",
  PHONE_LINKED_DELETION_PREPARED: "Couldn’t reach One. Try again.",
  PHONE_LINKED_CLAIM_REQUIRED: "Deletion requested. This number is not linked to your current account. Verify again, or use a different number.",
  // A missing local holder does not mean the number is free: a shared sign-in record
  // or an earlier, still-finishing deletion can keep it linked.
  PHONE_LINKED_ACCOUNT_NOT_FOUND: "There’s no active account left to delete for this number. If it still shows as linked, an earlier deletion may still be finishing. Use a different number, or contact one@hushh.ai.",
  PHONE_LINKED_DELETION_REAL_SMS_REQUIRED: "Deleting another account needs a real SMS verification of this number.",
  PHONE_TRANSFER_REAL_SMS_REQUIRED: "Deleting another account needs a real SMS verification of this number.",
  ACCOUNT_DELETE_REAUTH_REQUIRED: "To delete another account, sign in to this account with Google or Apple.",
  PHONE_RECOVERY_INDEPENDENT_SIGN_IN_REQUIRED: "Sign in to this account again with Google or Apple, then verify this number.",
};

export function linkedDeletionNeedsFreshProof(code: string | null | undefined): boolean {
  return Boolean(code) && !RETRYABLE.has(code!);
}

export function linkedDeletionMessage(code: string | null | undefined): string {
  const known = MESSAGES[code ?? ""];
  if (known) return known;
  if (EXPIRED.has(code ?? "")) return "Your code expired. Verify this number again.";
  return linkedDeletionNeedsFreshProof(code)
    ? "Couldn’t delete the other account. Verify this number again to retry."
    : "Couldn’t delete the other account. Try again.";
}

function linkedError(code: string): ApiError {
  return new ApiError(linkedDeletionMessage(code), 409, { code });
}

const unsettled = (receipt: LinkedDeletionReceipt | null) => !receipt || ["pending", "action_required"].includes(receipt.state);

/**
 * Request deletion of the number's holder with the retained real-SMS proof, or
 * (recheck) read back a sent confirmation without sending it or its proof again.
 * It never resolves: every outcome is a typed refusal, because a requested deletion
 * links nothing here and the receiving owner verifies the number again afterwards.
 */
export async function confirmLinkedDeletion(input: LinkedDeletionInput, ports: LinkedDeletionPorts): Promise<never> {
  // The server refuses every shared or configured test code for another owner's
  // account; refuse locally so a test code is never sent as deletion authority.
  if (input.testCode) throw linkedError("PHONE_LINKED_DELETION_REAL_SMS_REQUIRED");
  const user = ports.user();
  if (!user) throw new Error("Sign in before verifying a phone number.");
  const current = () => ports.user()?.uid === user.uid;
  const retained = ports.retained();
  // AuthProvider's owner fence binds the retained proof to this signed-in attempt.
  const owned = () => {
    if (!retained) return false;
    try { ports.requireOwner(retained.userId, retained.epoch); return true; } catch { return false; }
  };
  let receipt: LinkedDeletionReceipt | null = null;
  if (!input.recheck) {
    if (!retained || !owned()) throw linkedError("PHONE_LINKED_PROOF_REQUIRED");
    const proof: LinkedDeletionProof = { phone_id_token: retained.token };
    // A typed refusal is definite; a lost response is read back, never re-sent.
    receipt = await PhoneRecoveryService.confirmLinkedDeletion(user, input.operationId, input.phoneNumber, proof, current)
      .catch((error: unknown) => { if (apiErrorCode(error)) throw error; return null; });
  }
  // A lost response (or a recheck of one) may still be running on the server.
  const uncertain = receipt === null;
  for (let attempt = 0; attempt < 3 && unsettled(receipt); attempt += 1) {
    if (attempt > 0 || !input.recheck) await new Promise(resolve => setTimeout(resolve, 1_000));
    if (!current()) throw new Error("Your account changed. Sign in again.");
    receipt = await PhoneRecoveryService.linkedDeletionStatus(user, input.operationId, current).catch(() => receipt);
  }
  // Unsettled, or still "prepared" after an uncertain send, stays unconfirmed: never a
  // refusal, and never cancellable, because the sent request can still be admitted.
  if (unsettled(receipt) || (uncertain && receipt!.state === "prepared")) throw linkedError("PHONE_LINKED_DELETION_SUPPORT_REQUIRED");
  const deleted = receipt!.state === "admitted";
  // NOT_FOUND after proof means no live local holder remains: a fresh ordinary verification decides.
  if (!deleted && receipt!.code !== "PHONE_LINKED_ACCOUNT_NOT_FOUND") {
    throw linkedError(receipt!.code ?? `PHONE_LINKED_DELETION_${receipt!.state.toUpperCase()}`);
  }
  // Admission is not erasure or phone release. The spent proof was minted before
  // the deletion and can identify the previous holder's sign-in, so it never links
  // the number here; the receiving owner verifies the number again.
  if (!current()) throw new Error("Your account changed. Sign in again.");
  // Release only this attempt's proof; a newer attempt keeps its own. The outcome is reported either way.
  if (owned()) ports.releaseProof();
  throw linkedError(deleted ? "PHONE_LINKED_CLAIM_REQUIRED" : "PHONE_LINKED_ACCOUNT_NOT_FOUND");
}
