"use client";

import { Suspense } from "react";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { InvestmentsMasterView } from "@/components/kai/views/investments-master-view";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";

function KaiInvestmentsPageContent() {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();

  if (authLoading || !user) {
    return null;
  }

  return (
    <>
      <NativeTestBeacon
        routeId="/kai/investments"
        marker="native-route-kai-investments"
        authState="authenticated"
        dataState="loaded"
      />
      <InvestmentsMasterView
        userId={user.uid}
        vaultOwnerToken={vaultOwnerToken ?? ""}
      />
    </>
  );
}

export default function KaiInvestmentsPage() {
  return (
    <Suspense fallback={<HushhLoader label="Loading investments..." variant="fullscreen" />}>
      <KaiInvestmentsPageContent />
    </Suspense>
  );
}
