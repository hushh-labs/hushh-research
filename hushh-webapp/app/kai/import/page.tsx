"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { KaiFlow } from "@/components/kai/kai-flow";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { useStepProgress } from "@/lib/progress/step-progress-context";

function KaiImportPageContent() {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [initialized, setInitialized] = useState(false);
  const { registerSteps, completeStep, reset } = useStepProgress();

  useEffect(() => {
    if (authLoading) return;

    if (!initialized) {
      registerSteps(1);
      setInitialized(true);
    }

    if (user) {
      completeStep();
    }

    return () => reset();
  }, [authLoading, completeStep, initialized, registerSteps, reset, user]);

  if (authLoading || !user) {
    return null;
  }

  return (
    <FullscreenFlowShell
      as="div"
      width="wide"
      className="relative"
    >
      <KaiFlow
        userId={user.uid}
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
