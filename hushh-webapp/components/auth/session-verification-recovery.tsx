"use client";

import { useRef, useState } from "react";
import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
import { AccountRegistrationRecoveryPanel } from "./account-registration-recovery";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import { snapshotAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { withDeadline } from "@/lib/utils/with-deadline";

export function SessionVerificationRecovery({
  onRetry,
  onSignOut,
}: {
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const { user, userId: accountOwnerId, accountCleanup, accountRegistration } = useAuth();
  const deletionPending = isAccountDeletionActive(accountOwnerId);
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const [continuationFailure, setContinuationFailure] = useState<{ operationId: string; message: string } | null>(null);
  const cleanup = accountCleanup;
  const current = useRef({ user, cleanup });
  current.current = { user, cleanup };
  const continuing = Boolean(cleanup && continuingId === cleanup.id);
  const continuationError = cleanup && continuationFailure?.operationId === cleanup.id ? continuationFailure.message : null;
  // Only work the backend owns keeps going without the person. "Delayed" is the
  // backend's stall signal, never a client guess from elapsed time.
  const runsWithoutYou = Boolean(cleanup && !cleanup.local_erasure_confirmation_required &&
    (cleanup.state === "cleaning_up" || cleanup.state === "waiting_for_provider"));
  const delayed = runsWithoutYou && cleanup?.delayed === true;
  const title = cleanup?.state === "action_required"
    ? "Your cleanup needs attention"
    : delayed
      ? "Deletion is taking longer than usual"
      : cleanup?.state === "waiting_for_provider"
        ? "Waiting for your provider"
        : cleanup ? "Deleting your account" : deletionPending ? "Checking your account deletion" : "Reconnect to continue securely";
  const cleanupMessage = !cleanup
    ? null
    : !runsWithoutYou
      ? "Your private agent stays paused until this step is done."
      : delayed
        ? "Your information stays hidden. Deletion is queued on our side and finishes without you. You can sign out and check back later."
        : "Your private agent is paused while we delete your account. This usually takes a few minutes. You can close this window or sign out; deletion keeps going.";

  async function continueCleanup() {
    const owner = snapshotAuthSessionGeneration();
    if (!cleanup || !user || !owner || continuing) return;
    // Cleanup has its own Firebase-verified purpose boundary. A deleting
    // identity deliberately has no normal application-owner admission.
    const ownsCleanup = () => isValidatedAuthSessionOwnerCurrent(owner)
      && current.current.user?.uid === user.uid && current.current.cleanup?.id === cleanup.id;
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
      if (!response.ok) throw new Error("Cleanup needs review");
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
        <div
          aria-hidden="true"
          className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted text-xl"
        >
          🔒
        </div>
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
        {cleanup?.local_erasure_confirmation_required && <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This removes this environment’s encrypted copies. Shared provider access used by other environments and externally managed keys stay valid.
        </p>}
        {cleanup?.state === "action_required" && !cleanup.local_erasure_confirmation_required && <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Provider access needs review before we can finish. Your account remains paused and your cleanup information is retained.
        </p>}
        {continuationError && <p role="status" className="mt-3 text-sm text-destructive">{continuationError}</p>}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          {cleanup?.local_erasure_confirmation_required && <button
            className="min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50"
            disabled={continuing}
            onClick={() => void continueCleanup()}
            type="button"
          >{continuing ? "Confirming…" : "Remove Hussh’s copy"}</button>}
          <button
            className="min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background"
            onClick={onRetry}
            type="button"
          >
            {cleanup ? "Refresh status" : deletionPending ? "Check status" : "Try again"}
          </button>
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
