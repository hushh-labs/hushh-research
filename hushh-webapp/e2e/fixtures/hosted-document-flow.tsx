import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import { useMemo, useState } from "react";
import { HostedDocumentPanelBody } from "../../components/consent/hosted-document-panel";
import { DocumentHostingService } from "../../lib/services/document-hosting-service";
import { connectorKeyFingerprint } from "../../lib/consent/export-envelope-v2";
import { fixtureSession, OneKycClientZkService, setHostedFixtureActor, setHostedFixtureConfig, type HostedFixtureConfig } from "./hosted-document-boundaries";

/** Historical device-encrypted v1 intake via the real client/API, not a retired product control.
 * New default Drive + background-copy request UI has its own request-entry regressions. */
export async function createHistoricalDeviceRequest() {
  const session = fixtureSession("recipient");
  if (!session.isCurrent()) throw new Error("session_changed");
  const connector = await OneKycClientZkService.ensureConnector({ userId: "recipient" });
  if (!session.isCurrent()) throw new Error("session_changed");
  return DocumentHostingService.create(session, {
    version: 1, ownerPersonRef: "33333333-3333-4333-8333-333333333333", clientRequestId: crypto.randomUUID(),
    purpose: { purpose: "Statements", periodStart: "2026-10-01", periodEnd: "2026-10-25" },
    accessDays: 30, receiveThrough: "one", activityDisclosureVersion: "one-document-activity-v1", activityAccepted: true,
    recipientKeyId: connector.connector_key_id,
    recipientKeyFingerprint: (await connectorKeyFingerprint(connector.connector_public_key)).replace(/^sha256:/, ""),
  }, undefined, "recipient");
}

async function mount() {
  // Test-only loopback authority supplies generated, synthetic PKM material.
  // No production auth bypass, persistent credential store, trace or snapshot.
  // eslint-disable-next-line no-restricted-syntax -- Loopback-only synthetic auth/PKM transport; the production APIs below are unchanged.
  const config = await (await fetch("/__document_fixture/config")).json() as HostedFixtureConfig;
  setHostedFixtureConfig(config);
  function Fixture() {
    const [actor, setActor] = useState<"owner" | "recipient">(() => new URLSearchParams(window.location.search).get("actor") === "owner" ? "owner" : "recipient");
    const [requestId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("ref"));
    setHostedFixtureActor(actor);
    const session = useMemo(() => fixtureSession(actor), [actor]);
    return <main data-testid="document-fixture" data-actor={actor}>
      <h1>Historical device-encrypted document flow</h1>
      <button onClick={() => { setHostedFixtureActor("owner"); setActor("owner"); }}>Use owner session</button>
      <button onClick={() => { setHostedFixtureActor("recipient"); setActor("recipient"); }}>Use recipient session</button>
      {requestId ? <HostedDocumentPanelBody key={`${actor}:${requestId}`} session={session} requestId={requestId}
        getIdToken={async () => actor} onChanged={() => undefined} /> : null}
    </main>;
  }
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
void mount();
