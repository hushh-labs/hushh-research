"use client";

export const dynamic = "force-dynamic";

import { Suspense } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiFlow } from "@/components/kai/kai-flow";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";

function KaiImportPageContent() {
  const { user, userId, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  if (authLoading || !user || !userId) {
    return null;
  }

  return (
    <FullscreenFlowShell
      as="div"
      width="agent"
      className="app-type-compact relative shrink-0"
    >
      <NativeTestBeacon
        routeId="/one/kai/import"
        marker="native-route-kai-import"
        authState="authenticated"
        dataState="loaded"
      />
      <KaiFlow
        userId={userId}
        mode="import"
        vaultOwnerToken={vaultOwnerToken ?? ""}
      />
    </FullscreenFlowShell>
  );
}

export default function KaiImportPage() {
  return (
    <Suspense fallback={<HushhLoader label="Loading import..." variant="fullscreen" />}>
      <KaiImportPageContent />
    </Suspense>
  );
}
