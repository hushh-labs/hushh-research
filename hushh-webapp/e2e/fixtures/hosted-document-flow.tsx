import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import { useMemo, useState } from "react";
import { HostedDocumentPanelBody } from "../../components/consent/hosted-document-panel";
import { RequestFilesButton } from "../../components/consent/document-file-request";
import { fixtureSession, getFixtureOwnerToken, setHostedFixtureActor, setHostedFixtureConfig, type HostedFixtureConfig } from "./hosted-document-boundaries";

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
    return <main>
      <h1>Protected document flow</h1>
      <button onClick={() => { setHostedFixtureActor("owner"); setActor("owner"); }}>Use owner session</button>
      <button onClick={() => { setHostedFixtureActor("recipient"); setActor("recipient"); }}>Use recipient session</button>
      {!requestId ? <RequestFilesButton userId="recipient" personRef="33333333-3333-4333-8333-333333333333"
        personName="Owner" getToken={getFixtureOwnerToken} canRequest driveAllowed={false} /> : null}
      {requestId ? <HostedDocumentPanelBody key={`${actor}:${requestId}`} session={session} requestId={requestId}
        getIdToken={async () => actor} onChanged={() => undefined} /> : null}
    </main>;
  }
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
void mount();
