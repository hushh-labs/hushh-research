"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";
import { registrationAdvancesAlone } from "@/lib/auth/account-recovery-cadence";
import { snapshotAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { withDeadline } from "@/lib/utils/with-deadline";
import { RegistrationProgress } from "./account-deletion-progress";

const PROVIDERS = [
  { id: "google.com", label: "Verify with Google" },
  { id: "apple.com", label: "Verify with Apple" },
  { id: "microsoft.com", label: "Verify with Microsoft" },
] as const;
const PRIMARY = "min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50";
const SECONDARY = "min-h-11 rounded-full border border-border px-6 text-sm font-semibold text-foreground disabled:opacity-50";

export function AccountRegistrationRecoveryPanel({ user, recovery, onRetry, onSignOut }: {
  user: User;
  recovery: AccountRegistrationRecovery;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const current = useRef({ user, recovery });
  current.current = { user, recovery };
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [acceptedDigest, setAcceptedDigest] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [uncertainReview, setUncertainReview] = useState<AccountRegistrationRecovery | null>(null);
  const review = recovery.state === "ready" ? recovery.review : null;
  const providers = PROVIDERS.filter(provider => user.providerData?.some(item => item.providerId === provider.id));
  const title = review ? "Start fresh?" : recovery.state === "fresh_identity_required"
    ? "Verify it’s you" : recovery.state === "action_required"
      ? "Your previous cleanup needs attention" : recovery.state === "waiting_for_identity"
        ? "Your account was deleted" : "Your account is finishing cleanup";
  // The AuthProvider re-checks these states itself; everything else waits for the person.
  const advancesAlone = registrationAdvancesAlone(recovery);

  async function operate(provider?: typeof PROVIDERS[number]["id"]) {
    const episode = snapshotAuthSessionGeneration();
    if (!episode || running.current) return;
    if (!provider && (!review || acceptedDigest !== review.digest || uncertainReview === recovery)) return;
    const isCurrent = () => mounted.current && isValidatedAuthSessionOwnerCurrent(episode)
      && current.current.user.uid === user.uid && current.current.recovery === recovery;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (provider) {
        await AuthService.reauthenticateIdentity(user.uid, provider, isCurrent);
      } else if (review) {
        // The backend clock owns review expiry; device clock skew must not
        // turn a valid fresh sign-in into a local retry loop.
        const token = await withDeadline(user.getIdToken(false), Date.now() + 8_000);
        if (!isCurrent()) return;
        // The same operation is durable/idempotent, but a lost response still
        // requires status discovery rather than a second automatic POST.
        setUncertainReview(recovery);
        const response = await withDeadline(ApiService.startFreshAccount(token, review, isCurrent), Date.now() + 12_000);
        if (!isCurrent()) return;
        if (response.status === 409) {
          setAcceptedDigest(null);
          setUncertainReview(null);
          onRetry();
          return;
        }
        if (!response.ok) throw new Error("registration_unconfirmed");
      }
      if (isCurrent()) onRetry(); // Normal session admission owns releasing private screens.
    } catch (error) {
      if (!isCurrent()) return;
      setFailure(provider
        ? error instanceof Error && error.message === "native_identity_unavailable"
          ? "Verify this sign-in in One on the web."
          : "We couldn’t verify your sign-in. Try again."
        : "We couldn’t confirm the result. Refresh status before trying again.");
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <main className="flex min-h-[70vh] items-center justify-center bg-background px-6 py-12">
    <section aria-labelledby="registration-recovery-title" className="w-full max-w-md rounded-3xl border border-border/70 bg-card p-7 shadow-sm" role="alert">
      <h1 id="registration-recovery-title" className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{review
        ? "Your previous account was deleted. You can create a new account with this sign-in. Deleted information stays deleted."
        : recovery.state === "fresh_identity_required"
          ? "Verify your sign-in before creating a new account. Refreshing a session does not replace this check."
          : recovery.state === "action_required"
            ? "We need to confirm the previous cloud and access cleanup before you can start again. Your deleted information stays deleted."
            : recovery.state === "waiting_for_identity"
              ? "Your information was erased. For your security, you can verify your sign-in and start fresh in a moment."
              : "Cleanup continues if you close this window."}</p>
      {recovery.state !== "action_required" && <RegistrationProgress recovery={recovery} />}
      {review && <label className="mt-5 flex items-start gap-3 text-sm leading-6 text-foreground">
        <input type="checkbox" className="mt-1 size-4 shrink-0" disabled={busy} checked={acceptedDigest === review.digest}
          onChange={event => setAcceptedDigest(event.target.checked ? review.digest : null)} />
        <span>Create a new account. I’ll set up my vault, cloud and connections again.</span>
      </label>}
      {failure && <p className="mt-3 text-sm text-destructive" role="status">{failure}</p>}
      <div className="mt-6 flex flex-col gap-3">
        {review && <button className={PRIMARY} type="button" disabled={busy || acceptedDigest !== review.digest || uncertainReview === recovery}
          onClick={() => void operate()}>{busy ? "Creating your account…" : "Create new account"}</button>}
        {recovery.state === "fresh_identity_required" && providers.map(provider => <button key={provider.id} className={PRIMARY}
          type="button" disabled={busy} onClick={() => void operate(provider.id)}>{busy ? "Verifying…" : provider.label}</button>)}
        {!advancesAlone && <button className={SECONDARY} type="button" disabled={busy} onClick={onRetry}>Refresh status</button>}
        <button className={SECONDARY} type="button" disabled={busy} onClick={onSignOut}>Sign out</button>
      </div>
    </section>
  </main>;
}
