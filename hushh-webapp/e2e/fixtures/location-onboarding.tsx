import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OneLocationOnboardingFlow } from "../../components/one-location/onboarding/one-location-onboarding-flow";
import type { OneLocationOnboardingScreen } from "../../components/one-location/onboarding/one-location-onboarding-steps";
import { unwindBackLayer } from "../../lib/navigation/back-layers";

declare global {
  interface Window {
    onboardingFixture: { ready: boolean };
    onboardingBack: () => boolean;
  }
}

function Harness() {
  const [screen, setScreen] = useState<OneLocationOnboardingScreen>(window.onboardingFixture.ready ? "ready" : "welcome");
  const [exited, setExited] = useState(false);
  useEffect(() => {
    const previousBack = window.onboardingBack;
    window.onboardingBack = () => unwindBackLayer("/one/location");
    return () => { window.onboardingBack = previousBack; };
  }, []);
  return exited ? <div>Agents home</div> : (
    <OneLocationOnboardingFlow
      startAt={screen === "welcome" ? "welcome" : "permissions"}
      activeScreen={screen}
      onScreenChange={setScreen}
      currentUserName="Test User"
      locationPermission={{ state: "granted", precise: true, background: "foreground-only", locationServicesEnabled: true }}
      locationBusy={false}
      nativeTest={{ routeId: "/one/location", marker: "native-route-one-location", authState: "authenticated", dataState: "loaded" }}
      onRequestLocation={async () => true}
      onLocationReady={async () => true}
      onBack={() => setExited(true)}
      onComplete={() => setExited(true)}
      onSkip={() => setExited(true)}
      contactsStepAvailable
      onSyncOnboardingContacts={async () => ({ status: "none", partial: false })}
      onPrepareOnboardingCircleInvite={async () => ({ circleId: "fixture-circle", circleName: "Family", code: "ABCDEFGHJKLM" })}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
