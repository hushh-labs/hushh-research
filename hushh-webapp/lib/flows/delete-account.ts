"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { AccountService } from "@/lib/services/account-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { VaultService } from "@/lib/services/vault-service";
import {
  authSessionInvalidationCodeFromBackendPayload,
  authSessionInvalidationCodeFromFirebaseError,
  ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE,
  AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE,
  dispatchAuthSessionInvalidated,
  publishAccountDeletionToSiblingTabs,
} from "@/lib/auth/session-invalidation";
import type { User } from "firebase/auth";
import { withDeadline } from "@/lib/utils/with-deadline";

export type DeleteAccountAuthResolution =
  | { kind: "use_existing_token"; token: string; hasVault: true }
  | { kind: "issue_token"; token: string; hasVault: false }
  | { kind: "needs_unlock"; hasVault: true };

/**
 * Account deletion is one destructive account-level action, regardless of
 * whether its entry point is Profile or the onboarding shell. Keep the copy
 * and confirmed mutation here so route-local affordances cannot drift.
 */
export const DELETE_ACCOUNT_DIALOG_TITLE = "Delete One account?";
export const DELETE_ACCOUNT_DIALOG_DESCRIPTION =
  "Deletes your account, Vault, saved details, and connected-service access. Required security or legal records may be retained under our policy. This cannot be undone.";

type AccountDeletionSessionUser = Pick<User, "uid" | "getIdToken">;
type DeletionStatusProbe = "active" | "deleted" | "unavailable";
const DELETION_STATUS_MAX_BODY_BYTES = 4_096;

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

export function accountDeletionErrorMessage(error: unknown): string {
  if (error instanceof AccountDeletionOutcomeUncertainError) {
    return DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE;
  }
  if (isRecoverableAccountDeletionPrecondition(error)) {
    return ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_MESSAGE;
  }
  return "Failed to delete account. Please try again.";
}

async function probeDeletionStatus(
  idToken: string,
): Promise<DeletionStatusProbe> {
  try {
    const response = await ApiService.getAccountSessionStatus(idToken);
    const payload = await response
      .clone()
      .text()
      .catch(() => "");
    if (
      new TextEncoder().encode(payload).byteLength >
      DELETION_STATUS_MAX_BODY_BYTES
    ) {
      return "unavailable";
    }
    if (response.status === 200) {
      const contentType =
        response.headers.get("Content-Type")?.toLowerCase() ?? "";
      if (!contentType.split(";", 1)[0]?.trim().endsWith("json")) {
        return "unavailable";
      }
      try {
        const parsed: unknown = JSON.parse(payload);
        return typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          (parsed as { active?: unknown }).active === true
          ? "active"
          : "unavailable";
      } catch {
        return "unavailable";
      }
    }
    if (response.status !== 401) return "unavailable";
    return authSessionInvalidationCodeFromBackendPayload(payload) ===
      "account_not_found"
      ? "deleted"
      : "unavailable";
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
}): Promise<DeletionStatusProbe> {
  if (params.sessionUser.uid !== params.userId) return "unavailable";

  let cachedToken = params.recoveryIdToken;
  if (!cachedToken) {
    try {
      cachedToken = await params.sessionUser.getIdToken(false);
    } catch (error) {
      if (
        authSessionInvalidationCodeFromFirebaseError(error) ===
        "account_not_found"
      ) {
        return "deleted";
      }
    }
  }

  if (cachedToken) {
    const cachedStatus = await probeDeletionStatus(cachedToken);
    if (cachedStatus !== "unavailable") return cachedStatus;
  }

  let refreshedToken: string | null = null;
  try {
    refreshedToken = await params.sessionUser.getIdToken(true);
  } catch (error) {
    return authSessionInvalidationCodeFromFirebaseError(error) ===
      "account_not_found"
      ? "deleted"
      : "unavailable";
  }
  if (!refreshedToken) return "unavailable";
  return await probeDeletionStatus(refreshedToken);
}

export async function resolveDeleteAccountAuth(params: {
  userId: string;
  existingVaultOwnerToken: string | null;
}): Promise<DeleteAccountAuthResolution> {
  const hasVault = await VaultService.checkVault(params.userId);

  if (!hasVault) {
    const issued = await VaultService.getOrIssueVaultOwnerToken(
      params.userId,
      null,
      null,
    );
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
}): Promise<void> {
  if (params.sessionUser.uid !== params.userId) {
    throw new Error("Account deletion session identity changed. Please retry.");
  }

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

  let result;
  let submissionFailure: unknown = null;
  let terminalDeletionSignalDispatched = false;
  try {
    result = await AccountService.deleteAccount(params.vaultOwnerToken, "both");
  } catch (error) {
    submissionFailure = error;
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
    if (isRecoverableAccountDeletionPrecondition(submissionFailure)) {
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
            }),
            Date.now() + 8_000,
          ).catch(() => "unavailable" as const);
    if (deletionStatus !== "deleted") {
      // The destructive request may have committed even though neither status
      // probe observed its tombstone. Even a transient "active" result can be
      // a pre-commit snapshot while the original transaction is still running,
      // so it is never permission to expose Vault or automatically retry.
      // Fail closed locally: AuthProvider gates and tears down only this UID,
      // while the login notice explains that the outcome remains uncertain.
      dispatchAuthSessionInvalidated({
        code: "account_deletion_uncertain",
        path: "account_delete_uncertain_unverified",
        userId: params.userId,
      });
      throw new AccountDeletionOutcomeUncertainError(uncertainCause);
    }

    // Route the initiating surface through the same terminal session owner as
    // any other client that discovers this tombstone. Duplicate signals are
    // intentionally coalesced by AuthProvider.
    dispatchAuthSessionInvalidated({
      code: "account_not_found",
      path: "account_delete_uncertain_outcome",
      userId: params.userId,
    });
    terminalDeletionSignalDispatched = true;
    result = { success: true, account_deleted: true };
  }

  // Firebase sign-out propagates a plain `null` auth state to other browser
  // tabs and carries no reason. Publish the confirmed deletion first so those
  // tabs can show the account-not-found recovery notice instead of silently
  // falling into their ordinary signed-out redirect.
  publishAccountDeletionToSiblingTabs(params.userId);
  if (!terminalDeletionSignalDispatched) {
    // Lock decrypted memory and begin UID-scoped sign-out before awaiting any
    // slower local persistence cleanup. The initiating surface has a confirmed
    // success, so it receives success copy; sibling/other devices still use
    // the authoritative account-not-found notice.
    dispatchAuthSessionInvalidated({
      code: "account_deleted",
      path: "account_delete_confirmed",
      userId: params.userId,
    });
  }
  CacheSyncService.onAccountDeleted(params.userId);
  await UserLocalStateService.clearForUser(params.userId);
  setOnboardingRequiredCookie(false);
  setOnboardingFlowActiveCookie(false);
}
