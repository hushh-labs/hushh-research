"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { Button } from "@/lib/morphy-ux/button";
import { LostVaultDeletePanel } from "@/components/vault/lost-vault-delete-panel";
import TrustedDevicesPage from "@/components/profile/trusted-devices-page";
import { useTrustedDevicesModel } from "@/components/profile/use-trusted-devices-model";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent, getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { phoneRecoveryReviewRoute } from "@/lib/auth/phone-recovery-route";
import { withDeadline } from "@/lib/utils/with-deadline";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { PhoneRecoveryService, type PhoneRecoveryContinuation } from "@/lib/services/phone-recovery-service";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

type Props = {
  user: User; continuationId: string;
  signOut: (options: { redirectTo: string; expectedUserId?: string }) => Promise<void>;
};
export function PhoneRecoveryReview(props: Props) {
  return <PhoneRecoveryJourney key={`${props.user.uid}:${getAuthSessionGeneration()}:${props.continuationId}`} {...props} />;
}
function PhoneRecoveryJourney({ user: activeUser, continuationId, signOut }: Props) {
  const [user] = useState(activeUser);
  const router = useRouter();
  const [owner] = useState(() => snapshotValidatedAuthSessionPrincipal());
  const current = useCallback(() => Boolean(owner && owner.firebaseUid === user.uid && isValidatedAuthSessionOwnerCurrent(owner)), [owner, user.uid]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<PhoneRecoveryContinuation | null>(null);
  const [error, setError] = useState("");
  const [reviewingDeletion, setReviewingDeletion] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const devices = useTrustedDevicesModel(owner?.ownerId ?? null, result?.state === "ready" && result.action === "revoke", continuationId);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(""); setReviewingDeletion(false);
    void PhoneRecoveryService.read(user, continuationId, current, controller.signal)
      .then(value => { if (current() && !controller.signal.aborted) setResult(value); })
      .catch(() => { if (current() && !controller.signal.aborted) setError("Couldn’t check this request. Try again."); });
    return () => controller.abort();
  }, [user, continuationId, revision, current]);
  const cancel = useCallback(() => {
    if (blocked || devices.busy || signingOut) return true;
    if (reviewingDeletion) { setReviewingDeletion(false); return true; }
    router.replace(ROUTES.PHONE_MANDATE); return true;
  }, [blocked, devices.busy, reviewingDeletion, router, signingOut]);
  useBackLayer(ROUTES.PHONE_MANDATE, reviewingDeletion ? 3 : 2, cancel);
  const continueRecovery = async () => {
    if (!current() || signingOut) return;
    setSigningOut(true); setError("");
    try {
      const idToken = await withDeadline(user.getIdToken(), Date.now() + 8_000);
      if (!current()) return;
      const next = await withDeadline(PostAuthRouteService.resolveAfterLogin({ userId: owner!.ownerId, idToken,
        phoneNumber: user.phoneNumber }), Date.now() + 30_000);
      if (current()) router.replace(next);
    } catch { if (current()) { setSigningOut(false); setError("Couldn’t continue. Try again."); } }
  };
  const choosePreviousAccount = async () => {
    if (!current() || signingOut) return;
    setSigningOut(true); setError("");
    try { await signOut({ expectedUserId: owner!.ownerId, redirectTo: `${ROUTES.LOGIN}?redirect=${encodeURIComponent(phoneRecoveryReviewRoute(continuationId))}` }); }
    catch { if (current()) { setSigningOut(false); setError("Couldn’t open sign-in. Try again."); } }
  };
  return <FullscreenFlowShell width="narrow" className="min-h-dvh px-5 py-8">
    <div className="mx-auto w-full max-w-md space-y-5">
      <Button variant="none" disabled={blocked || devices.busy || signingOut} onClick={cancel}>Back</Button>
      {error ? <div role="alert" className="space-y-3"><p>{error}</p><Button onClick={() => setRevision(value => value + 1)}>Try again</Button></div> : null}
      {!result && !error ? <p role="status">Checking your account…</p> : null}
      {result?.state === "awaiting_previous_sign_in" ? <>
        <h1 className="text-2xl font-semibold">Sign in to your previous account</h1>
        <p>Use the Google or Apple account linked to that number.</p>
        <Button disabled={signingOut} onClick={() => void choosePreviousAccount()}>Choose account</Button>
      </> : result?.state === "expired" || result?.state === "stale" ? <>
        <h1 className="text-2xl font-semibold">This request has ended</h1><p>Go back and start again.</p>
      </> : result?.state === "ready" ? <>
        {!reviewingDeletion ? <>
          <h1 className="text-2xl font-semibold">{result.action === "recover" ? "Account recovered" : result.action === "delete" ? "Delete old account" : "Review trusted devices"}</h1>
          <p>{result.phone_hint}</p>
          <p>{user.email?.replace(/^(.).+(@.*)$/, "$1••$2")}</p>
          <p>{user.providerData?.some(provider => provider.providerId === "apple.com") ? "Apple account" : "Google account"}</p>
          {result.action === "recover" ? <Button disabled={signingOut} onClick={() => void continueRecovery()}>Continue to your account</Button> : null}
          {result.action === "delete" ? <><p>Review what will be removed before you confirm.</p><Button variant="destructive" onClick={() => setReviewingDeletion(true)}>Review deletion</Button></> : null}
          {result.action === "revoke" ? <><TrustedDevicesPage model={devices} />{devices.revocationConfirmed ? <><p role="status">Selected device unlinked.</p><Button disabled={signingOut} onClick={() => void continueRecovery()}>Continue to your account</Button></> : null}</> : null}
        </> : <LostVaultDeletePanel user={user} continuationId={continuationId} onBack={() => setReviewingDeletion(false)} onNavigationGuardChange={setBlocked} />}
      </> : null}
    </div>
  </FullscreenFlowShell>;
}
