"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";
import { canReauthenticateIdentityHere } from "@/lib/auth/identity-reauth-capability";
import { snapshotAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { LEGAL_CONTACT_EMAIL } from "@/lib/legal/legal-documents";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { withDeadline } from "@/lib/utils/with-deadline";
import { RegistrationProgress } from "./account-deletion-progress";
import { usePendingRetry } from "./use-pending-retry";

const PROVIDERS = [
  { id: "google.com", label: "Verify with Google" },
  { id: "apple.com", label: "Verify with Apple" },
  { id: "microsoft.com", label: "Verify with Microsoft" },
] as const;
const PRIMARY = "min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50";
const SECONDARY = "min-h-11 rounded-full border border-border px-6 text-sm font-semibold text-foreground disabled:opacity-50";
const NEEDS_VERIFICATION: AccountRegistrationRecovery = { state: "fresh_identity_required" };

/** "here": a linked provider this device can verify. "web": linked, but only the web can verify it. */
type Verification = "here" | "web" | "unavailable";

/** One honest title and body per state; the panel offers only controls that can change the outcome.
 * `phoneSession` is the session's own sign-in method, never a merely linked phone. */
export function registrationRecoveryCopy(recovery: AccountRegistrationRecovery, verification: Verification, phoneSession: boolean) {
  // Fresh proof comes only from Google, Apple or Microsoft, or a new email code; another session
  // never supplies it, so neither waiting nor refreshing can help it.
  if ((recovery.state === "fresh_identity_required" || recovery.state === "waiting_for_identity") && verification !== "here") {
    return verification === "web"
      ? { title: "Start fresh on the web", body: "This app can’t verify a Microsoft sign-in. Sign out, then sign in to One on the web with Microsoft to start fresh. Deleted information stays deleted." }
      : { title: phoneSession ? "Starting fresh with a phone sign-in isn’t available yet" : "Sign in again to start fresh",
        body: "Deleted information stays deleted. To create a new account, sign out, then choose a sign-in option on the next screen." };
  }
  switch (recovery.state) {
    case "ready":
      return { title: "Start fresh?", body: "Your previous account was deleted. You can create a new account with this sign-in. Deleted information stays deleted." };
    case "fresh_identity_required":
      return { title: "Verify it’s you", body: "Verify your sign-in before creating a new account. Refreshing a session does not replace this check." };
    case "action_required":
      // Neither reason expires or replays on its own; only support can settle it.
      return { title: "Your previous cleanup needs attention", body: recovery.reason === "identity_write_unconfirmed"
        ? "We couldn’t confirm a sign-in change made before your account was deleted, so a new account can’t start yet. Deleted information stays deleted. Email support and we’ll finish it with you."
        : "We couldn’t confirm that your previous account’s cleanup finished, so a new account can’t start yet. Deleted information stays deleted. Email support and we’ll finish it with you." };
    case "waiting_for_identity":
      return { title: "Your account was deleted", body: "Your information was erased. For your security, you can verify your sign-in and start fresh in a moment." };
    default:
      return { title: "Your account is finishing cleanup", body: "Cleanup continues if you close this window." };
  }
}

/** The session's own sign-in method from its token; null until read or when unknown. */
function useSessionSignInProvider(user: User): string | null {
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(user.getIdTokenResult?.(false))
      .then(result => { if (live) setProvider(result?.signInProvider ?? null); }, () => undefined);
    return () => { live = false; };
  }, [user]);
  return provider;
}

export function AccountRegistrationRecoveryPanel({ user, recovery, onRetry, onSignOut }: {
  user: User;
  recovery: AccountRegistrationRecovery;
  onRetry: () => void | Promise<unknown>;
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
  const [checking, refresh] = usePendingRetry(onRetry);
  const signInProvider = useSessionSignInProvider(user);
  const review = recovery.state === "ready" ? recovery.review : null;
  const linked = PROVIDERS.filter(provider => user.providerData?.some(item => item.providerId === provider.id));
  const providers = linked.filter(provider => canReauthenticateIdentityHere(provider.id));
  const verification: Verification = providers.length ? "here" : linked.length ? "web" : "unavailable";
  const { title, body } = registrationRecoveryCopy(recovery, verification, signInProvider === "phone");
  // Signing in another way is the only step left here, so it leads; no countdown promises otherwise.
  const signInElsewhere = (recovery.state === "fresh_identity_required" || recovery.state === "waiting_for_identity")
    && verification !== "here";

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
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
      {recovery.state !== "action_required" && <RegistrationProgress recovery={signInElsewhere ? NEEDS_VERIFICATION : recovery} />}
      {review && <label className="mt-5 flex items-start gap-3 text-sm leading-6 text-foreground">
        <input type="checkbox" className="mt-1 size-4 shrink-0" disabled={busy} checked={acceptedDigest === review.digest}
          onChange={event => setAcceptedDigest(event.target.checked ? review.digest : null)} />
        <span>Create a new account. I’ll set up my vault, cloud and connections again.</span>
      </label>}
      {failure && <p className="mt-3 text-sm text-destructive" role="status">{failure}</p>}
      {/* Pending labels must not re-announce the whole alert. */}
      <div aria-live="off" className="mt-6 flex flex-col gap-3">
        {review && <button className={PRIMARY} type="button" disabled={busy || acceptedDigest !== review.digest || uncertainReview === recovery}
          onClick={() => void operate()}>{busy ? "Creating your account…" : "Create new account"}</button>}
        {recovery.state === "fresh_identity_required" && providers.map(provider => <button key={provider.id} className={PRIMARY}
          type="button" disabled={busy} onClick={() => void operate(provider.id)}>{busy ? "Verifying…" : provider.label}</button>)}
        {recovery.state === "action_required" && <a className={`${PRIMARY} flex items-center justify-center`}
          href={`mailto:${LEGAL_CONTACT_EMAIL}`}>Email {LEGAL_CONTACT_EMAIL}</a>}
        {/* Only a review can change on refresh; every other state re-checks alone or needs another step. */}
        {review && <button className={SECONDARY} type="button" disabled={busy || checking} onClick={refresh}>
          {checking ? "Checking…" : "Refresh status"}</button>}
        <button className={signInElsewhere ? PRIMARY : SECONDARY} type="button" onClick={onSignOut}>Sign out</button>
      </div>
    </section>
  </main>;
}
