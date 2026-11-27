"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { LocationSetupFlow } from "@/components/location/setup/location-setup-flow";
import {
  advanceLocationChatSetup, getLocationChatSetupPhase, locationChatSetupReturnUrl, LOCATION_CHAT_SETUP_PARAM,
} from "@/lib/agent/location-chat-setup-handoff";
import { useAuth } from "@/lib/firebase/auth-context";
import { getSetupProgress, LOCATION_SHARING_CONSENT_VERSION } from "@/lib/location/setup-progress";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

export type LocationChatSetupIntroProps = { complete: () => Promise<void>; cancel: () => Promise<void> };
export function LocationChatSetupJourney({ handoffId, Intro }: {
  handoffId: string;
  Intro: ComponentType<LocationChatSetupIntroProps>;
}) {
  const router = useRouter();
  const { userId, loading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const vaultEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const scope = useMemo(() => userId && isVaultUnlocked && vaultKey && vaultOwnerToken
    ? { ownerId: userId, vaultKey, vaultEpoch, handoffId } : null,
  [userId, isVaultUnlocked, vaultKey, vaultOwnerToken, vaultEpoch, handoffId]);
  const current = useRef(scope);
  useLayoutEffect(() => {
    current.current = scope;
    return () => { current.current = null; };
  }, [scope]);
  const [loaded, setLoaded] = useState<{ scope: typeof scope; phase: "intro" | "consent" } | null>(null);
  const [retry, setRetry] = useState<{ scope: typeof scope; phase: "intro" | "consent" } | null>(null);
  useEffect(() => {
    let mounted = true;
    if (scope) void getLocationChatSetupPhase(scope).then((phase) => {
      if (!mounted || current.current !== scope) return;
      if (phase === "intro" || phase === "consent") setLoaded({ scope, phase });
      else router.replace(phase ? locationChatSetupReturnUrl(handoffId) : ROUTES.HOME);
    });
    else if (!loading && !userId) router.replace(ROUTES.HOME);
    return () => { mounted = false; };
  }, [scope, handoffId, router, loading, userId]);

  async function finish(outcome: "cancelled" | "completed") {
    if (!scope || current.current !== scope) return;
    const saved = await advanceLocationChatSetup(scope, outcome);
    if (current.current === scope) router.replace(saved ? locationChatSetupReturnUrl(handoffId) : ROUTES.HOME);
  }
  const cancel = () => finish("cancelled");
  useBackLayer(ROUTES.ONE_LOCATION, loaded?.scope === scope && loaded?.phase === "consent" ? 1 : 0,
    () => { void cancel(); return true; }, { [LOCATION_CHAT_SETUP_PARAM]: handoffId });

  async function completedWithCurrentConsent() {
    if (!scope || !vaultOwnerToken || current.current !== scope) return false;
    const progress = await getSetupProgress(vaultOwnerToken);
    return current.current === scope && (!progress.user_id || progress.user_id === scope.ownerId) &&
      progress.completed && progress.consent_version === LOCATION_SHARING_CONSENT_VERSION && Boolean(progress.consent_accepted_at);
  }
  async function finishIntro() {
    if (!scope || current.current !== scope) return;
    try {
      if (await completedWithCurrentConsent()) return finish("completed");
    } catch {
      if (current.current === scope) setRetry({ scope, phase: "intro" });
      return;
    }
    if (current.current !== scope) return;
    if (await advanceLocationChatSetup(scope, "consent") && current.current === scope) setLoaded({ scope, phase: "consent" });
    else if (current.current === scope) router.replace(ROUTES.HOME);
  }
  async function finishConsent() {
    try {
      if (await completedWithCurrentConsent()) return finish("completed");
    } catch { /* Offer the same retry when the server cannot verify progress. */ }
    if (current.current === scope) setRetry({ scope, phase: "consent" });
  }

  if (!loading && !scope) return <div className="space-y-3 p-4">
    <p role="status">Unlock your vault to continue Location setup.</p>
    <Button onClick={() => router.replace(locationChatSetupReturnUrl(handoffId))}>Return to Chat</Button>
  </div>;
  if (retry && retry.scope === scope) return <div className="space-y-3 p-4">
    <p role="status">Location couldn’t verify your sharing setup.</p>
    <Button onClick={() => { setRetry(null); void (retry.phase === "intro" ? finishIntro() : finishConsent()); }}>Try again</Button>
    <Button variant="plain" onClick={() => void cancel()}>Return to Chat</Button>
  </div>;
  if (!scope || loaded?.scope !== scope) return <HushhLoader variant="page" label="Opening Location setup…" />;
  if (loaded.phase === "intro") return <Intro complete={finishIntro} cancel={cancel} />;
  return <LocationSetupFlow mode="setup" onSetupComplete={finishConsent} onSetupSkip={cancel} />;
}
