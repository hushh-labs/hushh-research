import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SosPanel } from "../../components/one-location/redesign/sos-panel";
import type { OneLocationRecipient } from "../../lib/one-location/types";
const recipients: OneLocationRecipient[] = Array.from({ length: 8 }, (_, i) => ({
  userId: `fixture-${i}`, displayName: `Contact ${i + 1}`, phoneVerified: true,
  keyId: `key-${i}`, publicKeyJwk: { kty: "EC" }, keyAlgorithm: "ECDH-P256-AES256-GCM", canReceiveLocation: true,
}));
function Fixture() {
  const mixedReadiness = document.body.dataset.readiness === "mixed";
  const shownRecipients = mixedReadiness ? recipients.slice(0, 7).map((recipient, index) => ({
    ...recipient,
    phoneVerified: index > 2,
    displayName: index === 5 ? "Roopmann Varadharaj with a long contact name" : recipient.displayName,
    canReceiveLocation: index < 5,
    keyId: index < 5 ? recipient.keyId : null,
    publicKeyJwk: index < 5 ? recipient.publicKeyJwk : null,
  })) : recipients;
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  return <SosPanel recipients={shownRecipients} contactCount={8} active={active} busy={busy}
    onTrigger={async (note) => {
      setBusy(true);
      document.body.dataset.sentCount = String(Number(document.body.dataset.sentCount ?? 0) + 1);
      document.body.dataset.sentNote = note ?? "";
      await new Promise((resolve) => setTimeout(resolve, 25));
      setActive(true); setBusy(false);
    }}
    onStopSos={() => setActive(false)} stopBusy={false} onClose={() => {}} onEditContacts={() => {}}
    recipientLabel={(r) => r.displayName} isRecipientShareReady={(r) => r.canReceiveLocation}
    emergency={null} emergencyStatus="idle" onResolveEmergencyNumber={() => {}} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
