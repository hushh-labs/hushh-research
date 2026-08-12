"use client";

import { useState } from "react";

import RiaOnboardingPage from "@/app/ria/onboarding/page";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";

export function RiaOnboardingSetupClient() {
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "ria",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_ria",
    skipActionId: "setup.skip_ria",
  });

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing RIA setup…" />;

  return (
    <div className="flex min-h-[calc(100dvh-var(--top-shell-reserved-height,4rem)-var(--app-bottom-inset,2rem))] w-full flex-col justify-center items-center space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <RiaOnboardingPage
        setupMode
        onSetupReadinessChange={setReady}
        onSetupSkip={async () => {
          await coordinator.skip();
        }}
      />
      {ready ? (
        <SetupCapabilityTerminalFooter
          capabilityId="ria"
          isOperationallyReady
          coordinator={coordinator}
        />
      ) : null}
    </div>
  );
}
