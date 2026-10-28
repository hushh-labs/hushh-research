"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { AccountService, type AccountDeletionResult } from "@/lib/services/account-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { VaultService } from "@/lib/services/vault-service";
import {
  authSessionInvalidationCodeFromFirebaseError,
  ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE,
  AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE,
  dispatchAuthSessionInvalidated,
  publishAccountDeletionToSiblingTabs,
} from "@/lib/auth/session-invalidation";
import type { User } from "firebase/auth";
import {
  clearAccountDeletionActive,
  markAccountDeletionActive,
} from "@/lib/auth/account-deletion-activity";
import { withDeadline } from "@/lib/utils/with-deadline";
import { inspectAccountSessionStatusResponse } from "@/lib/auth/account-session-status";
import { ACCOUNT_SESSION_VALIDATION_BUDGET_MS } from "@/lib/auth/account-session-policy";
import {
  snapshotValidatedAuthSessionPrincipal,
  isValidatedAuthSessionOwnerCurrent,
  dispatchAuthSessionVerificationRequired,
} from "@/lib/auth/session-owner";
import {
  AccountDeletionNotCompletedError,
  isReportedAccountDeletionFailure,
  isLostVaultPrecommitError,
} from "./delete-account-outcomes";
import {
  ACCOUNT_ERASURE_BANKS_NOT_DISCONNECTED_MESSAGE,
  AccountErasureBanksNotDisconnectedError,
  revokeVaultBanksBeforeErasure,
} from "./delete-account-bank-preflight";
export {
  ACCOUNT_ERASURE_BANKS_NOT_DISCONNECTED_MESSAGE,
  AccountErasureBanksNotDisconnectedError,
  revokeVaultBanksBeforeErasure,
} from "./delete-account-bank-preflight";

export {
  ACCOUNT_DELETION_FAILED_CODE,
  ACCOUNT_DELETION_NOT_COMPLETED_MESSAGE,
  ACCOUNT_DELETION_PAUSED_CODE,
  ACCOUNT_DELETION_PAUSED_MESSAGE,
  FILES_ERASURE_IN_PROGRESS_CODE,
  AccountDeletionNotCompletedError,
} from "./delete-account-outcomes";

export type DeleteAccountAuthResolution =
  | { kind: "use_existing_token"; token: string; hasVault: true }
  | { kind: "issue_token"; token: string; hasVault: false }
  | { kind: "needs_unlock"; hasVault: true };

/**
 * Account deletion is one destructive account-level action, regardless of
 * whether its entry point is Profile or the onboarding shell. Keep the copy
 * and confirmed mutation here so route-local affordances cannot drift.
 */
export const DELETE_ACCOUNT_DIALOG_TITLE = "Delete account?";
export const DELETE_ACCOUNT_DIALOG_DESCRIPTION =
  "Deletes your account, vault, memory, chats, and connections.";

type AccountDeletionSessionUser = Pick<User, "uid" | "getIdToken">;
export type AccountDeletionOwner = NonNullable<ReturnType<typeof snapshotValidatedAuthSessionPrincipal>>;

/** Capture before any asynchronous preparation; never upgrade old work to a new owner. */
export function captureAccountDeletionOwner(userId: string): AccountDeletionOwner {
  const owner = snapshotValidatedAuthSessionPrincipal();
  if (!owner || owner.ownerId !== userId) {
    throw new Error("Account deletion session identity changed. Please retry.");
  }
  return owner;
}

function assertDeletionOwner(owner: AccountDeletionOwner, isCurrent?: () => boolean): void {
  if (!isValidatedAuthSessionOwnerCurrent(owner) || isCurrent?.() === false) {
    throw new Error("Account deletion cancelled before submission.");
  }
}
type DeletionStatusProbe = "active" | "deleted" | "in_progress" | "unavailable";

export const DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE =
  ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE;

export const ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE =
  "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING";
export const ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_MESSAGE =
  "Your private agent or cloud setup must be removed before the account can be deleted. Please try again later or contact support.";

function isRecoverableAccountDeletionPrecondition(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    apiErrorCode(error) ===
      ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE
  );
}

export class AccountDeletionOutcomeUncertainError extends Error {
  readonly code = "ACCOUNT_DELETION_OUTCOME_UNCERTAIN";

  constructor(readonly originalError: unknown) {
    super(DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE);
    this.name = "AccountDeletionOutcomeUncertainError";
  }
}

export class AccountDeletionPendingError extends Error {
  readonly code = "ACCOUNT_DELETION_PENDING";
  constructor() {
    super("Cleaning up your account. This continues if you close the app.");
    this.name = "AccountDeletionPendingError";
  }
}

export class AccountDeletionInProgressError extends Error {
  constructor() {
    super("Your account deletion status is still being checked. Please wait for confirmation.");
    this.name = "AccountDeletionInProgressError";
  }
}

/**
 * Outcomes the deletion UI already explains to the person. Callers log these as
 * warnings: they are expected results, not crashes, and the Next.js dev overlay
 * reports every console.error as an application issue.
 */
export function isHandledAccountDeletionOutcome(error: unknown): boolean {
  return (
    error instanceof AccountDeletionOutcomeUncertainError ||
    error instanceof AccountDeletionPendingError ||
    error instanceof AccountDeletionInProgressError ||
    error instanceof AccountDeletionNotCompletedError ||
    error instanceof AccountErasureBanksNotDisconnectedError ||
    isRecoverableAccountDeletionPrecondition(error)
  );
}

export function accountDeletionErrorMessage(error: unknown): string {
  if (error instanceof AccountDeletionPendingError || error instanceof AccountDeletionInProgressError) return error.message;
  if (error instanceof AccountDeletionOutcomeUncertainError) {
    return DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE;
  }
  if (error instanceof AccountDeletionNotCompletedError) {
    return error.message;
  }
  if (isRecoverableAccountDeletionPrecondition(error)) {
    return ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_MESSAGE;
  }
  if (error instanceof AccountErasureBanksNotDisconnectedError) {
    return ACCOUNT_ERASURE_BANKS_NOT_DISCONNECTED_MESSAGE;
  }
  return "Failed to delete account. Please try again.";
}

export function lostVaultDeletionErrorMessage(error: unknown): string {
  switch (apiErrorCode(error)) {
    case "PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED":
      return "This recovery request ended. Go back and start again.";
    case "ACCOUNT_DELETE_REAUTH_REQUIRED":
      return "Your sign-in check expired. Verify again.";
    case "ACCOUNT_DELETE_PHONE_PROOF_REQUIRED":
    case "ACCOUNT_DELETE_PHONE_PROOF_INVALID":
      return "That code did not work. Request a new code.";
    case "ACCOUNT_DELETE_METHOD_UNAVAILABLE":
    case "ACCOUNT_DELETE_PHONE_BINDING_CONFLICT":
      return "This check is unavailable. Contact support.";
    case "ACCOUNT_DELETE_VERIFICATION_UNAVAILABLE":
      return "We cannot verify you right now. Try later.";
    case "ACCOUNT_DELETE_CLEANUP_REVIEW_CHANGED":
    case "ACCOUNT_DELETE_CLEANUP_REVIEW_REQUIRED":
      return "Account details changed. Review deletion again.";
    case "ACCOUNT_DELETE_REVIEW_UNAVAILABLE":
      return "We couldn't review deletion right now. Try again.";
    case "PERSONAL_AGENT_DEPROVISION_REQUIRED":
      return "Your private agent must be removed first. Contact support.";
    default:
      return accountDeletionErrorMessage(error);
  }
}


async function probeDeletionStatus(idToken: string, owner: AccountDeletionOwner): Promise<DeletionStatusProbe> {
  try {
    if (!isValidatedAuthSessionOwnerCurrent(owner)) return "unavailable";
    const inspection = await inspectAccountSessionStatusResponse(
      await ApiService.getAccountDeletionStatus(idToken),
      Date.now() + ACCOUNT_SESSION_VALIDATION_BUDGET_MS,
      owner.firebaseUid,
    );
    if (!isValidatedAuthSessionOwnerCurrent(owner)) return "unavailable";
    if (inspection.outcome === "active") {
      return inspection.principal.ownerId === owner.ownerId && inspection.principal.accountGeneration === owner.accountGeneration ? "active" : "unavailable";
    }
    if (inspection.outcome === "deletion_in_progress") return "in_progress";
    return inspection.outcome === "terminal" &&
      (inspection.code === "account_not_found" || inspection.code === "account_deleted")
      ? "deleted" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * A successful destructive request can outlive its HTTP response. Confirm that
 * uncertain outcome through the exact Firebase identity and durable backend
 * tombstone before offering Retry; otherwise the erased VAULT_OWNER token
 * would turn a completed deletion into a permanent retry loop.
 */
async function confirmDeletionAfterUncertainResponse(params: {
  userId: string;
  sessionUser: AccountDeletionSessionUser;
  recoveryIdToken: string | null;
  owner: AccountDeletionOwner;
}): Promise<DeletionStatusProbe> {
  if (params.sessionUser.uid !== params.owner.firebaseUid || !isValidatedAuthSessionOwnerCurrent(params.owner)) return "unavailable";

  let cachedToken = params.recoveryIdToken;
  if (!cachedToken) {
    try {
      cachedToken = await params.sessionUser.getIdToken(false);
    } catch (error) {
      if (
        isValidatedAuthSessionOwnerCurrent(params.owner) &&
        authSessionInvalidationCodeFromFirebaseError(error) ===
        "account_not_found"
      ) {
        return "deleted";
      }
    }
  }

  if (!isValidatedAuthSessionOwnerCurrent(params.owner)) return "unavailable";
  if (cachedToken) {
    const cachedStatus = await probeDeletionStatus(cachedToken, params.owner);
    if (cachedStatus !== "unavailable") return cachedStatus;
  }

  if (!isValidatedAuthSessionOwnerCurrent(params.owner)) return "unavailable";
  let refreshedToken: string | null = null;
  try {
    refreshedToken = await params.sessionUser.getIdToken(true);
  } catch (error) {
    return isValidatedAuthSessionOwnerCurrent(params.owner) && authSessionInvalidationCodeFromFirebaseError(error) ===
      "account_not_found"
      ? "deleted"
      : "unavailable";
  }
  if (!refreshedToken || !isValidatedAuthSessionOwnerCurrent(params.owner)) return "unavailable";
  return await probeDeletionStatus(refreshedToken, params.owner);
}

export async function resolveDeleteAccountAuth(params: {
  userId: string;
  existingVaultOwnerToken: string | null;
  owner?: AccountDeletionOwner;
}): Promise<DeleteAccountAuthResolution> {
  const owner = params.owner ?? captureAccountDeletionOwner(params.userId);
  if (owner.ownerId !== params.userId) throw new Error("Account deletion owner changed.");
  assertDeletionOwner(owner);
  const hasVault = await VaultService.checkVault(params.userId);
  assertDeletionOwner(owner);

  if (!hasVault) {
    const issued = await VaultService.getOrIssueVaultOwnerToken(
      params.userId,
      null,
      null,
    );
    assertDeletionOwner(owner);
    return { kind: "issue_token", token: issued.token, hasVault: false };
  }

  if (params.existingVaultOwnerToken) {
    return {
      kind: "use_existing_token",
      token: params.existingVaultOwnerToken,
      hasVault: true,
    };
  }

  return { kind: "needs_unlock", hasVault: true };
}

/**
 * Execute the already-authorized, full One-account deletion and clear only the
 * browser state that belongs to that owner. A typed UID-scoped event hands
 * authentication teardown and final navigation to the central AuthProvider;
 * invoking UIs may await signOut as an idempotent settlement fallback.
 */
export async function executeVerifiedAccountDeletion(params: {
  userId: string;
  vaultOwnerToken: string;
  sessionUser: AccountDeletionSessionUser;
  /** When the vault is open, its bank connections are revoked at Plaid first. */
  vaultKey?: string | null;
  owner?: AccountDeletionOwner;
  isCurrent?: () => boolean;
}): Promise<void> {
  const owner = params.owner ?? captureAccountDeletionOwner(params.userId);
  if (params.sessionUser.uid !== owner.firebaseUid || owner.ownerId !== params.userId) {
    throw new Error("Account deletion session identity changed. Please retry.");
  }

  assertDeletionOwner(owner, params.isCurrent);
  const isCurrent = () => isValidatedAuthSessionOwnerCurrent(owner) && params.isCurrent?.() !== false;
  await revokeVaultBanksBeforeErasure({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    isCurrent,
  });

  await executeAccountDeletion({
    userId: params.userId,
    sessionUser: params.sessionUser,
    owner,
    isCurrent,
    performDeletion: () => AccountService.deleteAccount(params.vaultOwnerToken, "both", isCurrent),
  });
}

/** Delete a locked vault after the backend verifies recent provider and phone proofs. */
export async function executeLostVaultAccountDeletion(params: {
  userId: string;
  sessionUser: AccountDeletionSessionUser;
  firebaseIdToken: string;
  phoneIdToken?: string;
  continuationId?: string;
  reviewedInventorySha256?: string;
  acceptLocalErasure?: boolean;
  owner?: AccountDeletionOwner;
  /** The initiating UI/session can cancel until the destructive request starts. */
  isCurrent?: () => boolean;
}): Promise<AccountDeletionResult> {
  if (!params.firebaseIdToken) throw new Error("Fresh sign-in proof required.");
  const owner = params.owner ?? captureAccountDeletionOwner(params.userId);
  return executeAccountDeletion({
    userId: params.userId,
    sessionUser: params.sessionUser,
    isCurrent: params.isCurrent,
    owner,
    performDeletion: () => AccountService.deleteLostVaultAccount({
      firebaseIdToken: params.firebaseIdToken,
      phoneIdToken: params.phoneIdToken,
      ...(params.continuationId ? { continuationId: params.continuationId } : {}),
      ...(params.reviewedInventorySha256
        ? { reviewedInventorySha256: params.reviewedInventorySha256 }
        : {}),
      ...(params.acceptLocalErasure === true ? { acceptLocalErasure: true } : {}),
      isCurrent: () => isValidatedAuthSessionOwnerCurrent(owner) && params.isCurrent?.() !== false,
    }),
    isKnownPrecommitError: isLostVaultPrecommitError,
    handoffPendingToLogin: true,
  });
}

async function executeAccountDeletion(params: {
  userId: string;
  sessionUser: AccountDeletionSessionUser;
  owner: AccountDeletionOwner;
  performDeletion: () => Promise<AccountDeletionResult>;
  isKnownPrecommitError?: (error: unknown) => boolean;
  isCurrent?: () => boolean;
  handoffPendingToLogin?: boolean;
}): Promise<AccountDeletionResult> {
  // Preserve the exact approval owner across bank preflight and token capture.
  const owner = params.owner;
  if (params.sessionUser.uid !== owner.firebaseUid || owner.ownerId !== params.userId) {
    throw new Error("Account deletion session identity changed. Please retry.");
  }

  assertDeletionOwner(owner, params.isCurrent);
  // Capture a UID-bound Firebase credential before the destructive request.
  // Even if Firebase is removed and the HTTP response is lost, this token can
  // still ask the tombstone-aware status route for the committed outcome.
  const recoveryIdToken = await withDeadline(
    params.sessionUser.getIdToken(false),
    Date.now() + 8_000,
  ).catch((error: unknown) => {
    // Nothing has been submitted yet. A hung bridge must leave the action
    // retryable, not submit later or claim an uncertain destructive outcome.
    if (error instanceof Error && error.name === "TimeoutError") throw error;
    return null;
  });

  let result: AccountDeletionResult | undefined;
  let submissionFailure: unknown = null;
  let terminalDeletionSignalDispatched = false;
  // Token capture can yield to cancellation or an account switch. No deletion
  // has been submitted yet, so this is a definite pre-submission abort.
  assertDeletionOwner(owner, params.isCurrent);
  // From here the erasure may lock or remove this account's rows under any
  // background vault work still running on this page.
  markAccountDeletionActive(params.userId);
  try {
    result = await params.performDeletion();
  } catch (error) {
    submissionFailure = error;
  }

  if (result?.success === true && result.cleanup_pending === true && result.account_deleted === false &&
      result.cleanup_operation?.owner_id === params.userId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.cleanup_operation.id)) {
    if (params.handoffPendingToLogin &&
        result.cleanup_operation.local_erasure_confirmation_required === false &&
        isValidatedAuthSessionOwnerCurrent(owner)) {
      // The reviewed consent is durable, so the person may leave while the
      // worker finishes. This is a pending handoff, never deletion success.
      return result;
    }
    if (isValidatedAuthSessionOwnerCurrent(owner)) {
      dispatchAuthSessionVerificationRequired(owner, "AUTH_ACCOUNT_DELETION_IN_PROGRESS");
    }
    // No terminal cleanup, success toast, sign-out, or DELETE retry. The
    // centralized privacy gate discovers and follows the durable operation.
    throw new AccountDeletionPendingError();
  }

  if (
    submissionFailure !== null ||
    result?.success !== true ||
    result.account_deleted !== true
  ) {
    // This exact 409 is emitted before the destructive transaction starts.
    // Keep the authenticated session recoverable so the user can deprovision
    // their external agent and retry deliberately. Transport/lost-response
    // failures remain on the fail-closed confirmation path below.
    if (isRecoverableAccountDeletionPrecondition(submissionFailure) ||
        params.isKnownPrecommitError?.(submissionFailure)) {
      clearAccountDeletionActive(params.userId);
      throw submissionFailure;
    }
    const uncertainCause =
      submissionFailure ??
      new Error("Account deletion returned an unconfirmed response.");
    const deletionStatus =
      apiErrorCode(submissionFailure) === AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE
        ? "deleted"
        : await withDeadline(
            confirmDeletionAfterUncertainResponse({
              userId: params.userId,
              sessionUser: params.sessionUser,
              recoveryIdToken,
              owner,
            }),
            Date.now() + ACCOUNT_SESSION_VALIDATION_BUDGET_MS,
          ).catch(() => "unavailable" as const);
    if (deletionStatus === "in_progress" && owner &&
        isValidatedAuthSessionOwnerCurrent(owner)) {
      // A busy lifecycle barrier leaves deletion unconfirmed, not identity lost.
      // The existing UID/generation-scoped privacy gate seals protected UI and
      // owns bounded status reads with backoff. Never submit DELETE again.
      dispatchAuthSessionVerificationRequired(owner, "account_deletion_in_progress");
      throw new AccountDeletionInProgressError();
    }
    if (
      deletionStatus === "active" &&
      isReportedAccountDeletionFailure(submissionFailure)
    ) {
      // The backend confirmed a rollback, refusal or settled Files batch, so no
      // destructive transaction is still in flight and "active" is not a
      // pre-commit snapshot. Keep the session: signing out here would look
      // like a completed deletion while the account still exists.
      clearAccountDeletionActive(params.userId);
      throw new AccountDeletionNotCompletedError(submissionFailure);
    }
    if (deletionStatus !== "deleted") {
      // The destructive request may have committed even though neither status
      // probe observed its tombstone. Even a transient "active" result can be
      // a pre-commit snapshot while the original transaction is still running,
      // so it is never permission to expose Vault or automatically retry.
      // Fail closed locally: AuthProvider gates and tears down only this UID,
      // while the login notice explains that the outcome remains uncertain.
      if (isValidatedAuthSessionOwnerCurrent(owner)) dispatchAuthSessionInvalidated({
        code: "account_deletion_uncertain",
        path: "account_delete_uncertain_unverified",
        userId: params.userId,
        generation: owner.generation,
      });
      throw new AccountDeletionOutcomeUncertainError(uncertainCause);
    }

    // Route the initiating surface through the same terminal session owner as
    // any other client that discovers this tombstone. Duplicate signals are
    // intentionally coalesced by AuthProvider.
    if (isValidatedAuthSessionOwnerCurrent(owner)) dispatchAuthSessionInvalidated({
      code: "account_not_found",
      path: "account_delete_uncertain_outcome",
      userId: params.userId,
      generation: owner.generation,
    });
    terminalDeletionSignalDispatched = true;
    result = { success: true, account_deleted: true };
  }

  // Firebase sign-out propagates a plain `null` auth state to other browser
  // tabs and carries no reason. Publish the confirmed deletion first so those
  // tabs can show the account-not-found recovery notice instead of silently
  // falling into their ordinary signed-out redirect.
  if (isValidatedAuthSessionOwnerCurrent(owner)) {
    setOnboardingRequiredCookie(false);
    setOnboardingFlowActiveCookie(false);
    publishAccountDeletionToSiblingTabs(params.userId);
  }
  if (!terminalDeletionSignalDispatched && isValidatedAuthSessionOwnerCurrent(owner)) {
    // Lock decrypted memory and begin UID-scoped sign-out before awaiting any
    // slower local persistence cleanup. The initiating surface has a confirmed
    // success, so it receives success copy; sibling/other devices still use
    // the authoritative account-not-found notice.
    dispatchAuthSessionInvalidated({
      code: result.details?.firebase_auth_user === "identity_retained"
        ? "account_deletion_identity_retained"
        : result.ready_to_start_fresh === true
        ? "account_deleted_ready_to_start_fresh"
        : result.ready_to_start_fresh === false
          ? "account_deletion_finishing"
          : "account_deleted",
      path: "account_delete_confirmed",
      userId: params.userId,
      generation: owner.generation,
    });
  }
  CacheSyncService.onAccountDeleted(params.userId);
  await UserLocalStateService.clearForUser(params.userId, { deleteDurableReceipts: true });
  // Bounded: the deletion has committed, so a stalled Keychain or IndexedDB
  // bridge must not hold the success state open. The cleanup continues.
  await withDeadline(
    UserLocalStateService.clearDeviceSecretsForDeletedAccount(params.userId),
    Date.now() + 3_000,
  ).catch(() => undefined);
  return result;
}
