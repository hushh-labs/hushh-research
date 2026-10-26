import { ApiError, apiErrorCode } from "@/lib/services/api-client";

/** Backend code for an erasure transaction that raised and was rolled back. */
export const ACCOUNT_DELETION_FAILED_CODE = "ACCOUNT_DELETION_FAILED";
export const ACCOUNT_DELETION_NOT_COMPLETED_MESSAGE = "Account not deleted. Try again.";
/** Backend code for an erasure refused by a deploy's release fence. */
export const ACCOUNT_DELETION_PAUSED_CODE = "ACCOUNT_DELETION_PAUSED";
export const ACCOUNT_DELETION_PAUSED_MESSAGE =
  "Deletion paused while One updates. Try again soon.";
export const FILES_ERASURE_IN_PROGRESS_CODE = "FILES_ERASURE_IN_PROGRESS";
const FILES_ERASURE_IN_PROGRESS_MESSAGE =
  "Files cleanup is still in progress. Account not deleted. Try again to continue.";
const FILES_ERASURE_WAITING_FOR_WRITES_CODE = "FILES_ERASURE_WAITING_FOR_WRITES";
const FILES_ERASURE_WAITING_FOR_WRITES_MESSAGE =
  "An upload outcome is unverified. Account not deleted. Contact support before retrying.";

export function isReportedAccountDeletionFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const code = apiErrorCode(error);
  return (
    (error.status === 500 && code === ACCOUNT_DELETION_FAILED_CODE) ||
    (error.status === 503 && code === ACCOUNT_DELETION_PAUSED_CODE) ||
    (error.status === 409 &&
      (code === FILES_ERASURE_IN_PROGRESS_CODE || code === FILES_ERASURE_WAITING_FOR_WRITES_CODE))
  );
}

/**
 * The backend reported a failed erasure and the status route then confirmed
 * the account is still active. The account and session are intact, so the
 * person can retry deliberately instead of being signed out.
 */
export class AccountDeletionNotCompletedError extends Error {
  readonly code = "ACCOUNT_DELETION_NOT_COMPLETED";

  /** A deploy's release fence refused it; retrying after the release succeeds. */
  readonly paused: boolean;

  constructor(readonly originalError: unknown) {
    const paused = apiErrorCode(originalError) === ACCOUNT_DELETION_PAUSED_CODE;
    const filesPending = apiErrorCode(originalError) === FILES_ERASURE_IN_PROGRESS_CODE;
    const filesUnverified = apiErrorCode(originalError) === FILES_ERASURE_WAITING_FOR_WRITES_CODE;
    super(
      paused
        ? ACCOUNT_DELETION_PAUSED_MESSAGE
        : filesPending
          ? FILES_ERASURE_IN_PROGRESS_MESSAGE
          : filesUnverified
            ? FILES_ERASURE_WAITING_FOR_WRITES_MESSAGE
            : ACCOUNT_DELETION_NOT_COMPLETED_MESSAGE,
    );
    this.name = "AccountDeletionNotCompletedError";
    this.paused = paused;
  }
}

const LOST_VAULT_PRECOMMIT_CODES = new Set([
  "PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED",
  "ACCOUNT_DELETE_REAUTH_REQUIRED",
  "ACCOUNT_DELETE_PHONE_PROOF_REQUIRED",
  "ACCOUNT_DELETE_PHONE_PROOF_INVALID",
  "ACCOUNT_DELETE_METHOD_UNAVAILABLE",
  "ACCOUNT_DELETE_VERIFICATION_UNAVAILABLE",
  "ACCOUNT_DELETE_PHONE_BINDING_CONFLICT",
  "PERSONAL_AGENT_DEPROVISION_REQUIRED",
]);

export function isLostVaultPrecommitError(error: unknown): boolean {
  return error instanceof ApiError && LOST_VAULT_PRECOMMIT_CODES.has(apiErrorCode(error) ?? "");
}
