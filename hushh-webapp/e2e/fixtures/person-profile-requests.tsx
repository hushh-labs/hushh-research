import { startFramePacingProbe } from "@/lib/perf/frame-pacing";
import { useRef, useState } from "react";
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
import { FinancialPacketSummaryService, type FinancialPacketSummary } from "@/lib/services/financial-packet-summary-service";
import { DrivePacketService, type DiscoveryDrivePacket } from "@/lib/services/drive-packet-service";
import { DrivePacketCatalog } from "@/components/consent/drive-packet-catalog";
import { PacketPublicationsView, usePacketPublications } from "@/components/consent/packets/packet-publications";
import { usePersonProfilePackets } from "@/components/connections/person-profile-packets";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { dismissTopmostOverlay, unwindBackLayer } from "@/lib/navigation/back-layers";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";

const personRef = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const packetId = "33333333-3333-4333-8333-333333333333";
const packetMode = new URL(location.href).searchParams.get("packets");
const queryView = (query: string) => ({ requestId, direction: "outgoing", status: "pending", revision: 1, query,
  counterpartName: "Aarav Sharma", createdAt: "2026-09-24T10:00:00Z", expiresAt: "2036-10-01T10:00:00Z",
  decidedAt: null, answer: null, canDecide: false, lastError: null });
let lastQuery = "";
let accept: (() => void) | undefined;
declare global {
  interface Window {
    profileRequests: { hold: boolean; calls: string[]; accept(): void };
    packetProof: { reads: string[]; writes: string[]; refresh(): void; back(): boolean };
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

// Synthetic service boundaries keep the real packet hooks, owner-session guards,
// category Back layer, request controller and presentation in the browser proof.
let action: FinancialPacketSummary["viewerAction"] = packetMode === "request" ? "request" : packetMode === "pending" ? "pending" : "connect";
let visibility = { enabled: true, revision: 0, disclosure: "drive-financial-summary-default-v1" as const };
const summary = (): FinancialPacketSummary => ({ packetId, version: 1, category: "financial", title: "Financial documents",
  periodStart: "2026-07-01", periodEnd: "2026-08-31", timezone: "Asia/Kolkata", documentCount: 51, saleDocumentCount: 7,
  countBasis: "discovery_matches", complete: true, updatedAt: "2026-10-22T00:00:00Z",
  priceCents: 500, currency: "USD", availability: "ready", viewerAction: action });
const salePacket = (): DiscoveryDrivePacket => ({ ...summary(), kind: "provider_discovery", description: "Synthetic provider query matches.",
  coverageSummary: "Files matched the selected dates.", state: "ready", freshness: "current", documentCount: 51, saleDocumentCount: 7,
  listingRevision: 2, listingEnabled: true, canList: false, canRequest: true, requestId: null, purchaseState: "none" });
const ownerPacket = (): DiscoveryDrivePacket => ({ ...salePacket(), version: 0, title: "All financial statements", state: "building", freshness: "stale",
  documentCount: 51, saleDocumentCount: 0, canRequest: false, listingEnabled: false, listingRevision: 0,
  preview: { status: "completed", revision: 4, matched: 51, complete: true, stale: false, updatedAt: "2026-10-22T00:00:00Z", errorCode: null,
    tagging: { status: "completed", counts: { financial: 0, review: 2, other: 49, pending: 0 }, policyVersion: "synthetic-policy" },
    documents: [{ name: "Synthetic private statement.pdf", type: "bank statement", pages: 2, period: null,
      viewUrl: "https://drive.google.com/file/d/synthetic-private-id/view", shareable: false, packetTag: { bucket: "review", reason: "Uncertain classification" } }] } });
window.packetProof = { reads: [], writes: [], refresh: dispatchConsentStateChanged,
  back: () => dismissTopmostOverlay() || unwindBackLayer("/one/profile") };
if (packetMode) {
  publishValidatedAuthSessionPrincipal({ firebaseUid: "fixture-requester", ownerId: "fixture-requester", accountGeneration: 0 });
  Object.assign(FinancialPacketSummaryService, {
    list: async (_person: string, _token: string, guard: () => void) => { guard(); window.packetProof.reads.push("summary"); return { packets: [summary()], nextCursor: null }; },
    visibility: async (_token: string, guard: () => void) => { guard(); window.packetProof.reads.push("visibility"); return visibility; },
    setVisibility: async (_token: string, _expected: typeof visibility, enabled: boolean, guard: () => void) => {
      guard(); window.packetProof.writes.push(`visibility:${enabled}`); visibility = { ...visibility, enabled, revision: visibility.revision + 1 }; return visibility;
    },
    publications: async (_token: string, guard: () => void) => { guard(); return { packets: [], nextCursor: null }; },
  });
  Object.assign(DrivePacketService, {
    packets: async (_token: string, guard: () => void, owner?: string) => {
      guard(); window.packetProof.reads.push(owner ? "private-buyer" : "private-owner"); return { packets: [owner ? salePacket() : ownerPacket()], nextCursor: null };
    },
    preview: async (_token: string, _id: string, guard: () => void) => { guard(); window.packetProof.reads.push("preview"); return ownerPacket().preview; },
    preparePreview: async (_token: string, _id: string, guard: () => void) => { guard(); window.packetProof.writes.push("prepare-preview"); return ownerPacket().preview; },
    request: async (_token: string, _firebaseToken: string, _packet: DiscoveryDrivePacket, _key: string, guard: () => void) => {
      guard(); window.packetProof.writes.push("request"); return { requestId, existingAccess: false };
    },
  });
}

function FinancialPacketFixture() {
  const [connecting, setConnecting] = useState(false);
  const profilePackets = usePersonProfilePackets({ signedIn: true, personRef, ownerName: "Aarav Sharma", relationship: action === "request" ? "connected" : action === "pending" ? "pending_outgoing" : "none",
    privateCatalog: packetMode === "request", connecting,
    onConnect: async () => { setConnecting(true); window.packetProof.writes.push("connect"); action = "pending"; setConnecting(false); }, onUnlock: () => { throw new Error("Synthetic fixture is unlocked"); } });
  const publications = usePacketPublications(packetMode === "owner");
  return <AppPageShell width="reading" fitContent>
    <section aria-label={packetMode === "owner" ? "Owner financial packets" : "Person financial packets"}>
      {packetMode === "owner" ? <><h1>Google Drive</h1><PacketPublicationsView model={publications} /><DrivePacketCatalog periodPackets /></>
        : <><PersonProfileHero profile={{ displayName: "Aarav Sharma", verifiedRole: "Verified professional" }} status={<span>{action === "request" ? "Connected" : "Profile"}</span>}
          options={null} contacts={<p>aarav@example.test</p>} primaryActions={<Button variant="none">Share profile</Button>} tasks={null} footer={null} />
          {profilePackets.content}</>}
    </section>
  </AppPageShell>;
}

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
createRoot(document.getElementById("root")!).render(packetMode ? <FinancialPacketFixture /> : <Fixture />);
