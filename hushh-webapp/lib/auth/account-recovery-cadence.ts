import type { AccountCleanupOperation } from "@/lib/auth/account-cleanup-operation";
import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";

/** Availability failures keep the original ladder. */
const LADDER_MS = [2_000, 5_000, 10_000, 30_000] as const;
/** An unsettled identity write settles on the server; check slowly, never more than every 5 min. */
const SETTLE_LADDER_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** About two minutes of the backend's cadence hint; the ladder takes over after that. */
const FAST_CHECKS = 40;
/** The identity wait is about a minute; never park a check much longer than that. */
const MAX_WAIT_MS = 65_000;

/** Only these registration states advance without the person. Review, verification and
 * attention states wait for an explicit action and are never polled automatically. */
export function registrationAdvancesAlone(recovery: AccountRegistrationRecovery | null | undefined): boolean {
  return recovery?.state === "waiting_for_identity" || recovery?.state === "cleanup_pending"
    || recovery?.state === "action_required" && recovery.reason === "identity_write_unconfirmed";
}

/** Changes only when the polling plan changes, so an identical re-read keeps its attempt count. */
export function recoveryPollPhase(recovery: AccountRegistrationRecovery | null | undefined): string {
  if (!recovery) return "none";
  if (recovery.state === "action_required") return `${recovery.state}:${recovery.reason}`;
  return recovery.state === "waiting_for_identity" ? `${recovery.state}:${recovery.retry_at}` : recovery.state;
}

/** Delay before the AuthProvider's next session check. It follows backend hints and server
 * times only, never an elapsed-time guess about how cleanup is going. */
export function nextRecoveryCheckDelay(
  attempt: number,
  cleanup: AccountCleanupOperation | null | undefined,
  registration: AccountRegistrationRecovery | null | undefined,
  nowMs: number,
): number {
  const ladder = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)] ?? 30_000;
  if (registration?.state === "action_required") return SETTLE_LADDER_MS[Math.min(attempt, SETTLE_LADDER_MS.length - 1)] ?? 300_000;
  if (registration?.state === "waiting_for_identity") {
    // One check just after the server's time; the ladder absorbs device clock skew.
    const due = registration.retry_at * 1000 - nowMs;
    return due > 0 ? Math.min(due + 500, MAX_WAIT_MS) : ladder;
  }
  if (attempt >= FAST_CHECKS) return ladder;
  if (registration?.state === "cleanup_pending") return 3_000;
  const running = cleanup && !cleanup.delayed && !cleanup.local_erasure_confirmation_required
    && (cleanup.state === "cleaning_up" || cleanup.state === "waiting_for_provider");
  return running && cleanup.retry_after_seconds ? cleanup.retry_after_seconds * 1000 : ladder;
}
