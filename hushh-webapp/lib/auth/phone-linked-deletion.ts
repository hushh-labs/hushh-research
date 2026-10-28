import type { User } from "firebase/auth";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { requireUsablePhoneTestStart } from "@/lib/auth/phone-test-eligibility";
import { PhoneRecoveryService, type LinkedDeletionProof, type LinkedDeletionReceipt } from "@/lib/services/phone-recovery-service";

export type LinkedDeletionInput = { operationId: string; phoneNumber: string; testCode?: string };
type RetainedProof = { token: string; userId: string; epoch: number } | null;
/** AuthProvider keeps identity authority; this module only sequences existing calls. */
export type LinkedDeletionPorts = {
  user: () => User | null;
  retained: () => RetainedProof;
  requireOwner: (uid: string, epoch: number) => void;
  finalize: (user: User) => void;
};

const FRESH_PROOF = new Set(["PHONE_LINKED_PROOF_REQUIRED", "PHONE_TRANSFER_STALE", "INVALID_PHONE_ID_TOKEN",
  "PHONE_LINKED_DELETION_FRESH_SMS_REQUIRED", "PHONE_LINKED_CLAIM_REQUIRED", "PHONE_LINKED_DELETION_EXPIRED",
  "PHONE_LINKED_DELETION_ATTEMPTS_EXCEEDED"]);
const MESSAGES: Record<string, string> = {
  UAT_PHONE_TEST_INVALID_CODE: "That code isn’t right. Check it and try again.",
  PHONE_LINKED_DELETION_ATTEMPTS_EXCEEDED: "Too many wrong codes. Verify this number again.",
  PHONE_RECOVERY_LIMIT_REACHED: "Too many attempts. Try again in a few minutes.",
  PHONE_LINKED_DELETION_STALE: "That account changed. Go back and try again.",
  PHONE_LINKED_DELETION_EXPIRED: "This request ended. Verify this number again.",
  PHONE_LINKED_ACCOUNT_PROTECTED: "This account can’t be deleted here.",
  PHONE_LINKED_DELETION_RECOVERY_REQUIRED: "Recover that account first, then delete it there.",
  PERSONAL_AGENT_DEPROVISION_REQUIRED: "That account has its own cloud setup. Delete it from that account.",
  ACCOUNT_DELETION_PAUSED: "Deletion is paused for a few minutes. Try again soon.",
  PHONE_TRANSFER_IN_PROGRESS: "A phone transfer is still finishing. Try again soon.",
  PHONE_LINKED_DELETION_SUPPORT_REQUIRED: "We couldn’t confirm the deletion yet. Check again in a moment.",
  PHONE_LINKED_CLAIM_REQUIRED: "The other account was deleted. Verify this number again to continue.",
};

export function linkedDeletionNeedsFreshProof(code: string | null | undefined): boolean {
  return FRESH_PROOF.has(code ?? "");
}

export function linkedDeletionMessage(code: string | null | undefined): string {
  if (linkedDeletionNeedsFreshProof(code) && !MESSAGES[code ?? ""]) return "Your code expired. Verify this number again.";
  return MESSAGES[code ?? ""] ?? "Couldn’t delete the other account. Try again.";
}

function linkedError(code: string): ApiError {
  return new ApiError(linkedDeletionMessage(code), 409, { code });
}

const unsettled = (receipt: LinkedDeletionReceipt | null) => !receipt || ["pending", "action_required"].includes(receipt.state);

/** Delete the holder with the proof already in hand, then claim the number through existing routes. */
export async function confirmLinkedDeletion(input: LinkedDeletionInput, ports: LinkedDeletionPorts): Promise<User> {
  const user = ports.user();
  if (!user) throw new Error("Sign in before verifying a phone number.");
  const current = () => ports.user()?.uid === user.uid;
  const retained = input.testCode ? null : ports.retained();
  if (!input.testCode && retained?.userId !== user.uid) throw linkedError("PHONE_LINKED_PROOF_REQUIRED");
  if (retained) ports.requireOwner(retained.userId, retained.epoch);
  const proof: LinkedDeletionProof = input.testCode ? { test_code: input.testCode } : { phone_id_token: retained!.token };
  // A typed refusal is definite; a lost response is read back, never re-sent.
  let receipt = await PhoneRecoveryService.confirmLinkedDeletion(user, input.operationId, input.phoneNumber, proof, current)
    .catch((error: unknown) => { if (apiErrorCode(error)) throw error; return null; });
  for (let attempt = 0; attempt < 3 && unsettled(receipt); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    if (!current()) throw new Error("Your account changed. Sign in again.");
    receipt = await PhoneRecoveryService.linkedDeletionStatus(user, input.operationId, current).catch(() => receipt);
  }
  // NOT_FOUND after proof means no live holder remains: the ordinary claim decides.
  if (!receipt || (receipt.state !== "admitted" && receipt.code !== "PHONE_LINKED_ACCOUNT_NOT_FOUND")) {
    throw linkedError(receipt?.code ?? (receipt ? `PHONE_LINKED_DELETION_${receipt.state.toUpperCase()}` : "PHONE_LINKED_DELETION_SUPPORT_REQUIRED"));
  }
  try {
    await claimNumber(user, input.phoneNumber, proof);
  } catch (error) {
    if (!current()) throw error;
    throw linkedError("PHONE_LINKED_CLAIM_REQUIRED");
  }
  if (!current()) throw new Error("Your account changed. Sign in again.");
  ports.finalize(user);
  return user;
}

async function claimNumber(user: User, phone: string, proof: LinkedDeletionProof): Promise<void> {
  let identity;
  if (proof.test_code) {
    const start = await AccountIdentityService.startUatTestPhoneVerification(user, phone);
    requireUsablePhoneTestStart(start);
    if (!start?.eligible || !start.verification_id) throw new Error("Phone verification is unavailable.");
    identity = await AccountIdentityService.confirmUatTestPhoneVerification(user,
      { phoneNumber: phone, verificationCode: proof.test_code, verificationId: start.verification_id });
  } else {
    identity = await AccountIdentityService.claimCurrentUserPhone(user, proof.phone_id_token!);
  }
  if (!AccountIdentityService.hasVerifiedPhone(identity)) throw new Error("Phone verification could not be completed.");
}
