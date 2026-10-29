import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OneLocationOnboardingFlow } from "../../components/one-location/onboarding/one-location-onboarding-flow";
import type { OneLocationOnboardingScreen } from "../../components/one-location/onboarding/one-location-onboarding-steps";
import { SavedPlacesBanner } from "../../components/one-location/saved-places-banner";
import { unwindBackLayer } from "../../lib/navigation/back-layers";

declare global {
  interface Window {
    onboardingFixture: { ready: boolean; banner?: boolean };
    onboardingBack: () => boolean;
  }
}

function Harness() {
  const [screen, setScreen] = useState<OneLocationOnboardingScreen>(window.onboardingFixture.ready ? "ready" : "features");
  const [exited, setExited] = useState(false);
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  useEffect(() => {
    const previousBack = window.onboardingBack;
    window.onboardingBack = () => unwindBackLayer("/one/location");
    return () => { window.onboardingBack = previousBack; };
  }, []);
  if (window.onboardingFixture.banner) {
    return <main style={{ maxWidth: 820, margin: "0 auto", padding: 16 }}>
      <h1 className="ui-text-page-title" style={{ marginBottom: 16 }}>Location</h1>
      {exited ? <p>Places reminder dismissed</p> : <SavedPlacesBanner busy={false} onSave={() => {}} onDismiss={() => setExited(true)} />}
    </main>;
  }
  return exited ? <div>Agents home</div> : (
    <OneLocationOnboardingFlow
      startAt="features"
      activeScreen={screen}
      onScreenChange={setScreen}
      currentUserName="Test User"
      nativeTest={{ routeId: "/one/location", marker: "native-route-one-location", authState: "authenticated", dataState: "loaded" }}
      onBack={() => setExited(true)}
      onComplete={() => setExited(true)}
      onSkip={() => setExited(true)}
      onPrepareLocation={async () => { setPoint({ latitude: 19.076, longitude: 72.8777 }); return true; }}
      place={{
        mapInitial: point,
        address: point ? "12 MG Road, Bengaluru 560001" : null,
        onPickExactLocation: () => {},
        onSave: async () => true,
      }}
      contactsStepAvailable
      onSyncOnboardingContacts={async () => ({ status: "none", partial: false })}
      onPreviewCircleCode={async () => ({ name: "Family", ownerDisplayName: "Test User", memberCount: 3, alreadyMember: false })}
      onAcceptCircleCode={async () => {}}
      onPrepareOnboardingCircleInvite={async () => ({ circleId: "fixture-circle", circleName: "Family", code: "ABCDEFGHJKLM" })}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
