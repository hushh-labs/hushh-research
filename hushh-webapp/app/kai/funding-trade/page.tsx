"use client";

import { Suspense } from "react";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { FundingTradeView } from "@/components/kai/views/funding-trade-view";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";

function KaiFundingTradePageContent() {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();

  if (authLoading || !user) {
    return null;
  }

  return (
    <>
      <NativeTestBeacon
        routeId="/kai/funding-trade"
        marker="native-route-kai-funding-trade"
        authState="authenticated"
        dataState="loaded"
      />
      <FundingTradeView
        userId={user.uid}
        vaultOwnerToken={vaultOwnerToken ?? ""}
      />
    </>
  );
}

export default function KaiFundingTradePage() {
  return (
    <Suspense fallback={<HushhLoader label="Loading one-click trade..." variant="fullscreen" />}>
      <KaiFundingTradePageContent />
    </Suspense>
  );
}
