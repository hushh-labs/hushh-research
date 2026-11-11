"use client";

import { useEffect, useRef, useState } from "react";
import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
import { accountDeletionSteps } from "@/lib/auth/account-deletion-progress";
import { buildLoginRouteWithAuthSessionNotice } from "@/lib/auth/session-invalidation";
import { AccountDeletionMark, AccountDeletionProgress } from "./account-deletion-progress";
import { AccountRegistrationRecoveryPanel } from "./account-registration-recovery";
import { usePendingRetry } from "./use-pending-retry";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import { startJourneyTrace } from "@/lib/observability/journey-trace";
import { snapshotAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { withDeadline } from "@/lib/utils/with-deadline";

export function SessionVerificationRecovery({
  onRetry,
  onSignOut,
}: {
  onRetry: () => void | Promise<unknown>;
  onSignOut: () => void;
}) {
  const { user, userId: accountOwnerId, accountCleanup, accountRegistration, signOut } = useAuth();
  const deletionPending = isAccountDeletionActive(accountOwnerId);
  const [trace] = useState(() => startJourneyTrace("session_recovery"));
  const [checking, refresh] = usePendingRetry(onRetry, trace);
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const [continuationFailure, setContinuationFailure] = useState<{ operationId: string; message: string } | null>(null);
  const [acceptedOperationId, setAcceptedOperationId] = useState<string | null>(null);
  const [acknowledgedReview, setAcknowledgedReview] = useState<string | null>(null);
  const cleanup = accountCleanup;
  const current = useRef({ user, cleanup });
  current.current = { user, cleanup };
  const session = snapshotAuthSessionGeneration();
  const reviewKey = user && cleanup && session
    ? JSON.stringify([user.uid, session.generation, cleanup.id, cleanup.inventory_sha256])
    : null;
  const acknowledged = reviewKey !== null && acknowledgedReview === reviewKey;
  const continuing = Boolean(cleanup && continuingId === cleanup.id);
  const continuationError = cleanup && continuationFailure?.operationId === cleanup.id ? continuationFailure.message : null;
  const localErasureConfirmationRequired = cleanup?.local_erasure_confirmation_required === true;
  const canContinueCleanup = localErasureConfirmationRequired || cleanup?.state === "action_required";
  const continueLabel = localErasureConfirmationRequired ? "Permanently delete account" : "Retry cleanup";
  const continuingLabel = localErasureConfirmationRequired ? "Confirming…" : "Retrying…";
  // Only work the backend owns keeps going without the person. "Delayed" is the
  // backend's stall signal, never a client guess from elapsed time.
  const runsWithoutYou = Boolean(cleanup && !cleanup.local_erasure_confirmation_required &&
    (cleanup.state === "cleaning_up" || cleanup.state === "waiting_for_provider"));
  const delayed = runsWithoutYou && cleanup?.delayed === true;
  // The AuthProvider re-checks on the backend's cadence, so a working deletion needs no
  // manual refresh. Steps that need the person keep their controls.
  const advancesAlone = runsWithoutYou && !delayed;
  const cleanupState = cleanup?.state ?? null;
  useEffect(() => {
    // The registration panel traces its own screens.
    if (!accountRegistration) trace("shown", { cleanup: cleanupState, delayed, deletion_pending: deletionPending, advances_alone: advancesAlone });
  }, [trace, accountRegistration, cleanupState, delayed, deletionPending, advancesAlone]);
  const steps = cleanup ? accountDeletionSteps(cleanup, null) : null;
  const title = localErasureConfirmationRequired
    ? "Finish account deletion"
    : cleanup?.state === "action_required"
      ? "Your cleanup needs attention"
    : delayed
      ? "Deletion is taking longer than usual"
      : cleanup?.state === "waiting_for_provider"
        ? "Waiting for your provider"
        : cleanup ? "Deleting your account" : deletionPending ? "Checking your account deletion" : "Reconnect to continue securely";
  const cleanupMessage = !cleanup
    ? null
    : localErasureConfirmationRequired
      ? "Confirm your earlier deletion request to finish cleanup."
      : !runsWithoutYou
        ? "Agent One stays paused until this step is done."
      : delayed
        ? "Your information stays hidden. Deletion is queued on our side and finishes without you. You can sign out and check back later."
        : "Agent One is paused while we erase your information. You can close this window or sign out; deletion keeps going.";

  async function continueCleanup() {
    const owner = snapshotAuthSessionGeneration();
    const currentReviewKey = user && cleanup && owner
      ? JSON.stringify([user.uid, owner.generation, cleanup.id, cleanup.inventory_sha256])
      : null;
    if (!cleanup || !user || !owner || continuing || acceptedOperationId === cleanup.id ||
        (localErasureConfirmationRequired && (currentReviewKey === null || acknowledgedReview !== currentReviewKey))) return;
    // Cleanup has its own Firebase-verified purpose boundary. A deleting
    // identity deliberately has no normal application-owner admission.
    const ownsCleanup = () => isValidatedAuthSessionOwnerCurrent(owner)
      && current.current.user?.uid === user.uid
      && current.current.cleanup?.id === cleanup.id
      && current.current.cleanup?.inventory_sha256 === cleanup.inventory_sha256;
    setContinuingId(cleanup.id);
    setContinuationFailure(null);
    try {
      const token = await withDeadline(user.getIdToken(false), Date.now() + 8_000);
      if (!ownsCleanup()) return;
      const response = await ApiService.continueAccountCleanup(
        token, cleanup, cleanup.local_erasure_confirmation_required,
        ownsCleanup,
      );
      if (!ownsCleanup()) return;
      if (response.status === 409) {
        setContinuationFailure({ operationId: cleanup.id, message: "Cleanup could not continue under the current review. Refresh status; contact support if it stays paused." });
        return;
      }
      if (!response.ok) throw new Error("Cleanup needs review");
      if (localErasureConfirmationRequired) {
        setAcceptedOperationId(cleanup.id);
        try {
          await signOut({
            redirectTo: buildLoginRouteWithAuthSessionNotice("account_deletion_requested"),
          });
        } catch {
          if (ownsCleanup()) {
            setContinuationFailure({ operationId: cleanup.id, message: "Deletion requested. Sign out to return to login." });
          }
        }
        return;
      }
      onRetry();
    } catch {
      if (ownsCleanup()) {
        setContinuationFailure({ operationId: cleanup.id, message: "We couldn’t continue cleanup. Refresh its status and try again." });
      }
    } finally {
      setContinuingId(current => current === cleanup.id ? null : current);
    }
  }
  if (user && accountRegistration) return <AccountRegistrationRecoveryPanel user={user} recovery={accountRegistration} onRetry={onRetry} onSignOut={onSignOut} />;
  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-background px-6 py-12">
      <section
        aria-labelledby="session-verification-title"
        className="w-full max-w-md rounded-3xl border border-border/70 bg-card p-7 text-center shadow-sm"
        role="alert"
      >
        {steps ? <AccountDeletionMark still={!advancesAlone} /> : <div
          aria-hidden="true"
          className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted text-xl"
        >
          🔒
        </div>}
        <h1
          id="session-verification-title"
          className="text-xl font-semibold tracking-tight text-foreground"
        >
          {title}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {cleanupMessage
            ? cleanupMessage
            : deletionPending ? "Your account deletion is still being checked. Your private information stays hidden until we confirm the result." : "We couldn’t verify this account, so your private information stayed hidden. Check your connection and try again."}
        </p>
        {cleanup?.local_erasure_confirmation_required && <>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Removes Hussh’s encrypted copies. Shared provider access and external keys remain valid.
          </p>
          <label className="mt-3 flex items-start gap-2 text-left text-sm text-foreground">
            <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledgedReview(event.target.checked ? reviewKey : null)} />
            <span>I agree to finish deleting this account.</span>
          </label>
        </>}
        {cleanup?.state === "action_required" && !cleanup.local_erasure_confirmation_required && <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Provider access needs review before we can finish. Retry cleanup, or contact support if it stays paused.
        </p>}
        {steps && <AccountDeletionProgress steps={steps} />}
        {continuationError && <p role="status" className="mt-3 text-sm text-destructive">{continuationError}</p>}
        {/* Pending labels must not re-announce the whole alert. */}
        <div aria-live="off" className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
          {canContinueCleanup && <button
            className="min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50"
            disabled={continuing || acceptedOperationId === cleanup?.id || (localErasureConfirmationRequired && !acknowledged)}
            onClick={() => void continueCleanup()}
            type="button"
          >{continuing ? continuingLabel : continueLabel}</button>}
          {(!advancesAlone || continuationError) && <button
            className="min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50"
            disabled={checking}
            onClick={refresh}
            type="button"
          >
            {checking ? "Checking…" : cleanup ? "Refresh status" : deletionPending ? "Check status" : "Try again"}
          </button>}
          <button
            className="min-h-11 rounded-full border border-border px-6 text-sm font-semibold text-foreground"
            onClick={onSignOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}
