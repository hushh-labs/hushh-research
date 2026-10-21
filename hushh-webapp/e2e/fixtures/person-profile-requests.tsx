import { startFramePacingProbe } from "@/lib/perf/frame-pacing";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { DocumentRequestButton } from "@/components/consent/document-request-button";
import { RequestScopeButton } from "@/components/consent/request-scope-button";
import { RequestCardsButton } from "@/components/wallet/request-cards-button";
import { PersonProfileHero } from "@/components/connections/person-profile-hero";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { Button } from "@/lib/morphy-ux/button";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { DriveRequestPricingService } from "@/lib/services/drive-request-pricing-service";
import { DriveRequestRequesterService } from "@/lib/services/drive-request-requester-service";
import { DriveSharingService } from "@/lib/services/drive-sharing-service";
import { AnswerRequestService } from "@/lib/services/answer-request-service";
import { WalletCardAccessService } from "@/lib/services/wallet-card-access-service";

const personRef = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const queryView = (query: string) => ({ requestId, direction: "outgoing", status: "pending", revision: 1, query,
  counterpartName: "Aarav Sharma", createdAt: "2026-09-24T10:00:00Z", expiresAt: "2036-10-01T10:00:00Z",
  decidedAt: null, answer: null, canDecide: false, lastError: null });
let lastQuery = "";
let accept: (() => void) | undefined;
declare global {
  interface Window {
    profileRequests: { hold: boolean; calls: string[]; accept(): void };
  }
}
window.profileRequests = { hold: false, calls: [], accept: () => accept?.() };
async function acknowledge(kind: string) {
  window.profileRequests.calls.push(kind);
  if (window.profileRequests.hold) await new Promise<void>(resolve => { accept = resolve; });
}
// Replace boundary methods, retaining each service module's real public helpers.
Object.assign(ExternalConnectorService, { overview: async () => ({ features: { drive_document_sharing: true }, connectors: [], driveAgentPackagesEnabled: false }) });
Object.assign(DriveRequestPricingService, { quote: async () => ({ amountCents: 1000, version: 1, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true }) });
Object.assign(DriveRequestRequesterService, { recipientIdentity: async () => ({ email: "recipient@example.test", provider: "google.com" }) });
Object.assign(DriveSharingService, {
  create: async () => { await acknowledge("files"); return { requestId, status: "pending", revision: 1 }; },
  createQuery: async (_token: string, draft: { query: string }) => { lastQuery = draft.query; await acknowledge("drive"); return queryView(lastQuery); },
  getQuery: async () => queryView(lastQuery), lookupClient: async () => null,
});
Object.assign(AnswerRequestService, { gates: async () => ({ requests: true, payments: false, payouts: false }), create: async () => { await acknowledge("question"); return { requestId }; } });
Object.assign(WalletCardAccessService, { createRequest: async () => { await acknowledge("card"); return { id: requestId, role: "requester", status: "pending", requesterPersonRef: personRef, requesterName: "Fixture", ownerName: "Aarav Sharma", createdAt: "2026-10-16T00:00:00Z", expiresAt: "2036-10-23T00:00:00Z" }; } });

function Fixture() {
  const share = useRef<HTMLButtonElement>(null);
  return <AppPageShell width="agent" fitContent>
    <PersonProfileHero profile={{ displayName: "Aarav Sharma", verifiedRole: "Verified professional" }}
      status={<span>Connected</span>} options={null} contacts={<p>aarav@example.test</p>}
      primaryActions={<Button ref={share} variant="none">Share profile</Button>}
      tasks={<><DocumentRequestButton personRef={personRef} personName="Aarav Sharma" />
        <RequestScopeButton personRef={personRef} personName="Aarav Sharma" />
        <RequestCardsButton personRef={personRef} personName="Aarav Sharma" returnFocusRef={share} /></>}
      footer={<p>Shared with you</p>} />
  </AppPageShell>;
}
if (new URL(location.href).searchParams.get("perf") === "1") startFramePacingProbe({ hud: false });
createRoot(document.getElementById("root")!).render(<Fixture />);
