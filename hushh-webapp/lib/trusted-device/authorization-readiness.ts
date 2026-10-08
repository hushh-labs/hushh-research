"use client";

import { hasExplicitIncompleteSetup } from "@/lib/onboarding/onboarding-journey-phase";

import { useEffect, useState } from "react";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

export type DevicePrerequisite = "login_required" | "account_setup_required";
type Readiness = DevicePrerequisite | "checking" | "unavailable" | "ready";

export const DEVICE_SETUP_MESSAGE =
  "Sign in to One and finish setting up your account, then try connecting again from Puppy One.";

/** Negative callback only: no credentials, approval code, or arbitrary redirect. */
export function devicePrerequisiteCallback(
  redirectUri: string,
  state: string,
  error: DevicePrerequisite,
): string | null {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(state)) return null;
  try {
    const url = new URL(redirectUri);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/callback"
    )
      return null;
    url.searchParams.set("state", state);
    url.searchParams.set("error", error);
    return url.toString();
  } catch {
    return null;
  }
}

export function useDeviceAuthorizationReadiness(
  userId: string | null,
  authLoading: boolean,
  sessionVerificationRequired = false,
): Readiness {
  const [result, setResult] = useState<{
    owner: string;
    state: Readiness;
  } | null>(null);
  useEffect(() => {
    if (authLoading || !userId || sessionVerificationRequired) return;
    let active = true;
    setResult({ owner: userId, state: "checking" });
    const timer = setTimeout(() => {
      if (active) setResult({ owner: userId, state: "unavailable" });
      active = false;
    }, 30_000);
    void PreVaultUserStateService.bootstrapState(userId, { force: true })
      .then((state) => {
        if (!active) return;
        let readiness: Readiness = "ready";
        if (
          state.userId !== userId ||
          state.hasVault == null ||
          state.phoneVerified == null
        ) {
          readiness = "unavailable";
        } else if (
          !state.hasVault ||
          !state.phoneVerified ||
          hasExplicitIncompleteSetup(state)
        ) {
          readiness = "account_setup_required";
        }
        setResult({ owner: userId, state: readiness });
      })
      .catch(() => {
        if (active) setResult({ owner: userId, state: "unavailable" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [authLoading, userId, sessionVerificationRequired]);
  if (authLoading) return "checking";
  if (!userId) return "login_required";
  if (sessionVerificationRequired) return "unavailable";
  return result?.owner === userId ? result.state : "checking";
}
