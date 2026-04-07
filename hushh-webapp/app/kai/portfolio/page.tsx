"use client";

import { useEffect, useState } from "react";

import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { KaiFlow, type FlowState } from "@/components/kai/kai-flow";
import { useAuth } from "@/lib/firebase/auth-context";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { useVault } from "@/lib/vault/vault-context";

export default function KaiPortfolioPage() {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const { registerSteps, completeStep, reset } = useStepProgress();

  const [initialized, setInitialized] = useState(false);
  const [flowState, setFlowState] = useState<FlowState>("checking");

  useEffect(() => {
    if (authLoading) return;
    if (!initialized) {
      registerSteps(2);
      setInitialized(true);
    }
    if (user) {
      completeStep();
    }
    return () => reset();
  }, [authLoading, completeStep, initialized, registerSteps, reset, user]);

  useEffect(() => {
    if (!initialized) return;
    if (flowState !== "checking") {
      completeStep();
    }
  }, [completeStep, flowState, initialized]);

  if (authLoading || !user) {
    return null;
  }

  return (
    <AppPageShell
      as="div"
      width="expanded"
      className="relative pb-32"
      nativeTest={{
        routeId: "/kai/portfolio",
        marker: "native-route-kai-portfolio",
        authState: "authenticated",
        dataState: flowState === "checking" ? "loading" : "loaded",
      }}
    >
      <AppPageContentRegion>
        <KaiFlow
          userId={user.uid}
          mode="dashboard"
          vaultOwnerToken={vaultOwnerToken ?? ""}
          onStateChange={setFlowState}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
