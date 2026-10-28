/** Static, enumerated login copy; provider text and credentials never enter it. */
import type { AuthSessionInvalidationCode, AuthSessionLandingNotice } from "./session-invalidation";

export const ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE =
  "We couldn't confirm whether account deletion finished. For your security, we signed you out and won't retry it automatically. Please check your connection before signing in again.";

export const LANDING_NOTICES: Record<
  AuthSessionInvalidationCode,
  AuthSessionLandingNotice
> = {
  account_not_found: {
    code: "account_not_found",
    message: "Account not found. Redirecting you to login screen.",
    toastId: "auth-session-account-not-found",
  },
  account_deleted: {
    code: "account_deleted",
    message: "This account’s information was deleted. Contact support if you cannot start again.",
    toastId: "auth-session-account-deleted",
  },
  account_deleted_ready_to_start_fresh: {
    code: "account_deleted_ready_to_start_fresh",
    message: "Your old account is deleted. Continue below to start fresh.",
    toastId: "auth-session-account-deleted-ready",
  },
  account_deletion_finishing: {
    code: "account_deletion_finishing",
    message: "Your information is deleted. Account removal still needs attention. Contact support before signing up again.",
    toastId: "auth-session-account-deletion-finishing",
  },
  account_deletion_requested: {
    code: "account_deletion_requested",
    message: "Deletion requested. Cleanup continues; sign in to check progress.",
    toastId: "auth-session-account-deletion-requested",
  },
  account_deletion_identity_retained: {
    code: "account_deletion_identity_retained",
    message: "Your information in this environment is deleted. Your shared sign-in identity was retained and will not be removed automatically. Contact support before starting again.",
    toastId: "auth-session-account-deletion-identity-retained",
  },
  account_deletion_uncertain: {
    code: "account_deletion_uncertain",
    message: ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE,
    toastId: "auth-session-account-deletion-uncertain",
  },
  session_invalid: {
    code: "session_invalid",
    message: "Your session is no longer valid. Please sign in again.",
    toastId: "auth-session-invalid",
  },
};
