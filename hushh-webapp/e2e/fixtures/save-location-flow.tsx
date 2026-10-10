import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SaveLocationModal } from "../../components/one-location/onboarding/save-location-modal";
import { useSessionChromeSuppression } from "../../lib/auth/use-session-chrome-suppression";

declare global {
  interface Window {
    placeFixture: { native: boolean; onboarding: boolean; unified: boolean };
    finishPlaceSave: () => void;
  }
}

const address = "Godrej Greens, Pune, Maharashtra 411045, India";

// The saving components, modal transports and stylesheet are production code.
// Only the external map SDK and persistence are replaced at their boundaries.
function Harness() {
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  useSessionChromeSuppression(window.placeFixture.onboarding);
  window.finishPlaceSave = () => {
    setSaving(false);
    setOpen(false);
  };
  return (
    <>
      <div data-app-scroll-root="true">Location settings</div>
      <button data-testid="reopen-place-flow" onClick={() => setOpen(true)}>Add place</button>
      <div data-app-bottom-shell style={{ position: "fixed", bottom: 20, left: 16, right: 16 }}>
        <button data-agent-bar-shell style={{ height: 52, width: "100%", background: "white" }}>Talk to One</button>
        <nav data-app-bottom-nav style={{ height: 60, background: "white" }}>Chat · One · Connect · Feed · Search</nav>
      </div>
      <SaveLocationModal
        open={open}
        saving={saving}
        address={address}
        mapInitial={{ latitude: 18.582, longitude: 73.733 }}
        reverseGeocode={async () => address}
        onPickExactLocation={() => {}}
        rendererDisclosureAccepted
        startWithMapPicker
        collectAddressDetails
        takeover={window.placeFixture.onboarding && !window.placeFixture.unified}
        unifiedOnboarding={window.placeFixture.unified}
        onSave={() => { setSaving(true); }}
        onSkip={() => setOpen(false)}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
