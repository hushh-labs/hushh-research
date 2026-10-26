"use client";

import { useEffect, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "@/hooks/use-auth";
import { HushhLocation, type BackgroundShareSession } from "@/lib/capacitor";
import { activeOwnerGrants, useLocationSharingState, useOneLocationStateSnapshot } from "@/lib/location/sharing-state";
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";
import { hasBackgroundSharingConsent, updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { getApiBaseUrl } from "@/lib/services/api-service";
import { useVault } from "@/lib/vault/vault-context";

/** The sole native background owner; independent of voice and route lifetime. */
export function BackgroundLocationPublisherBridge() {
  const { userId } = useAuth();
  const uid = userId ?? null;
  const { vaultOwnerToken } = useVault();
  const sharing = useLocationSharingState();
  const state = useOneLocationStateSnapshot();
  const control = useOneLocationControlState(uid);
  const grants = useMemo(() => activeOwnerGrants(state), [state]);
  const session = uid && vaultOwnerToken ? buildBackgroundShareSession({
    precision: sharing.precision,
    activeGrants: grants.filter((grant) => grant.ownerUserId === uid),
    recipients: state?.recipients ?? [],
    vaultOwnerToken,
    backendBaseUrl: getApiBaseUrl(),
    minMoveMeters: 25,
    minIntervalMs: 8_000,
  }) : null;
  // Compare the actual wire input: late recipient keys, precision and expiry
  // changes all reconcile, while unrelated resource refreshes do not restart GPS.
  const signature = JSON.stringify(session);
  const enabled = sharing.effective === "sharing" && !control.paused && hasBackgroundSharingConsent(control);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const currentSession = JSON.parse(signature) as BackgroundShareSession | null;
    let current = true;
    const refused = () => {
      if (!current || !enabled || !currentSession?.grants.length) return;
      updateOneLocationControlState(uid, (value) => ({ ...value, backgroundSharingEnabled: false, backgroundDisclosureVersion: null }));
      morphyToast.error("Background sharing could not start. Review your device permissions and try again.");
    };
    void syncBackgroundShare({ enabled, session: currentSession }).then((started) => {
      if (!started) refused();
    }).catch(refused);
    return () => { current = false; };
  }, [enabled, signature, uid]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !uid) return;
    const listener = HushhLocation.addListener("backgroundShareStopped", () => {
      updateOneLocationControlState(uid, (value) => ({ ...value, backgroundSharingEnabled: false, backgroundDisclosureVersion: null }));
    });
    return () => { void listener.then((handle) => handle.remove()); };
  }, [uid]);

  useEffect(() => () => {
    if (Capacitor.isNativePlatform()) void HushhLocation.stopBackgroundShare().catch(() => undefined);
    updateOneLocationControlState(uid, (value) => ({ ...value, backgroundSharingEnabled: false, backgroundDisclosureVersion: null }));
  }, [uid]);
  return null;
}
