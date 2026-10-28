/** Production phone journey, with recorded provider selection outside the app. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "../../components/ui/sonner";
import "../../app/globals.css";
import { AuthProvider, useAuth } from "../../lib/firebase/auth-context";
import { VaultContext } from "../../lib/vault/vault-context";
import { PhoneMandatePageContent } from "../../app/register-phone/page";
import { getAuthSessionLandingNotice } from "../../lib/auth/session-invalidation";
import TrustedDevicesPage from "../../components/profile/trusted-devices-page";
import { useTrustedDevicesModel } from "../../components/profile/use-trusted-devices-model";
import { usePathname, useRouter, useSearchParams, selectFixtureAccount } from "./phone-conflict-boundaries";

const lockedVault = { vaultKey: null, vaultOwnerToken: null, tokenExpiresAt: null,
  isVaultUnlocked: false, ownerTokenStatus: "locked" as const,
  retryOwnerTokenRenewal: async () => undefined, unlockVault: () => false,
  lockVault() {}, getVaultKey: () => null, getVaultOwnerToken: () => null };
function Devices() {
  const { userId, loading, sessionVerificationRequired } = useAuth();
  const model = useTrustedDevicesModel(userId, !!userId && !loading && !sessionVerificationRequired);
  return <TrustedDevicesPage model={model} />;
}
function Journey() {
  const { user, loading, sessionVerificationRequired } = useAuth();
  const path = usePathname(); const params = useSearchParams(); const router = useRouter();
  const [error, setError] = useState("");
  const choose = async (owner: "previous" | "wrong") => {
    try { await selectFixtureAccount(owner); router.replace(params.get("redirect") || "/register-phone"); }
    catch { setError("Recorded sign-in failed"); }
  };
  const notice = getAuthSessionLandingNotice(params.get("auth_notice"));
  return <>
    <output data-testid="phone-fixture-auth">{loading ? "loading" : user?.uid || "anonymous"}:{sessionVerificationRequired ? "sealed" : "settled"}</output>
    {path === "/register-phone" ? <PhoneMandatePageContent /> : path === "/fixture/devices" ? <Devices /> : path === "/login" ? <main>
      <h1>Recorded Google or Apple account selection</h1>
      <button onClick={() => void choose("wrong")}>Use unrelated account</button>
      <button onClick={() => void choose("previous")}>Use previous account</button>
      {notice ? <p role="status">{notice.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </main> : <main><h1>Journey destination</h1><output data-testid="phone-fixture-destination">{path}</output>{notice ? <p role="status">{notice.message}</p> : null}</main>}
    <Toaster
      position="top-center"
      closeButton
      offset={{ top: "calc(var(--top-inset, 0px) + 12px)" }}
      mobileOffset={{ top: "calc(var(--top-inset, 0px) + 12px)", left: "1rem", right: "1rem" }}
    />
  </>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><VaultContext.Provider value={lockedVault}><Journey /></VaultContext.Provider></AuthProvider>);
