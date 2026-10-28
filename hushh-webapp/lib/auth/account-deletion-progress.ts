import type { AccountCleanupOperation } from "@/lib/auth/account-cleanup-operation";
import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";

/** Same meaning as the shared stream list: "waiting" is paused on the person. */
export type AccountDeletionStepStatus = "running" | "waiting" | "done" | "blocked";
export type AccountDeletionStep = Readonly<{
  id: "closed" | "erasing" | "sign_in" | "verify" | "start_fresh";
  label: string;
  message: string;
  status: AccountDeletionStepStatus;
}>;

const CLOSED: AccountDeletionStep = { id: "closed", label: "Account closed", message: "Your private agent is paused.", status: "done" };
const DELETED: AccountDeletionStep = { id: "closed", label: "Account closed", message: "Your account was deleted.", status: "done" };
const ERASED: AccountDeletionStep = { id: "erasing", label: "Information erased", message: "Your information was removed from One.", status: "done" };
const SECURED: AccountDeletionStep = { id: "sign_in", label: "Sign-in secured", message: "Earlier sign-ins can’t be reused.", status: "done" };

function erasing(cleanup: AccountCleanupOperation | null): AccountDeletionStep {
  const step = { id: "erasing", label: "Erasing your information" } as const;
  if (cleanup?.local_erasure_confirmation_required) {
    return { ...step, message: "Confirm below to finish deleting your account.", status: "waiting" };
  }
  if (cleanup?.state === "action_required") {
    return { ...step, label: "Cleanup needs attention", message: "Provider access needs review before we can finish.", status: "blocked" };
  }
  // "delayed" is the backend's stall signal, never a client guess from elapsed time.
  if (cleanup?.delayed) return { ...step, message: "Taking longer than usual. It finishes without you.", status: "running" };
  if (cleanup?.state === "waiting_for_provider") {
    return { ...step, message: "A connected service is confirming its access was removed.", status: "running" };
  }
  return { ...step, message: "Removing your information from One.", status: "running" };
}

export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Completed steps plus the current one, projected from backend states only: no invented
 * future steps, elapsed-time percentages or client-side stall guesses. */
export function accountDeletionSteps(
  cleanup: AccountCleanupOperation | null,
  registration: AccountRegistrationRecovery | null,
): AccountDeletionStep[] {
  if (!registration || registration.state === "cleanup_pending") return [CLOSED, erasing(cleanup)];
  if (registration.state === "action_required") {
    return [DELETED, { id: "erasing", label: "Cleanup needs attention", message: "We need to confirm the previous cleanup first.", status: "blocked" }];
  }
  if (registration.state === "waiting_for_identity") {
    return [DELETED, ERASED, { id: "sign_in", label: "Securing your sign-in", message: "A fresh sign-in opens shortly.", status: "running" }];
  }
  return [DELETED, ERASED, SECURED, registration.state === "ready"
    ? { id: "start_fresh", label: "Start fresh", message: "Confirm below to create your new account.", status: "waiting" }
    : { id: "verify", label: "Verify it’s you", message: "Sign in again to continue.", status: "waiting" }];
}
