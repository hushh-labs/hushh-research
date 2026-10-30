import { createRoot } from "react-dom/client";
import { AgentMemorySaveCard } from "../../components/agent/agent-memory-save-card";
import { PkmMemoryDetail } from "../../components/profile/pkm-memory-detail";
import type { PkmSaveReceipt } from "../../lib/agent/pkm-save-receipt";
import { buildPkmMemoryCardsFromNode } from "../../lib/pkm/pkm-memory-cards";

/**
 * The reserved-branch surfaces, every value synthetic. `?state=offers` is a
 * save receipt whose facts belong to app screens ("Add as Home in Location");
 * `?state=memory` is a Memory item in an app-owned branch, read-only with
 * "Open in Location"; `?state=memory-kyc` is an identity item, read-only with
 * "Open in Mail" (Mail's KYC tab). Nothing here touches the network or a vault.
 */
const RECEIPT: PkmSaveReceipt = {
  saved: 3, updated: 0, merged: 0, unchanged: 0, skipped: 0, excluded: 0, unreadable: 0,
  needsOwner: 0, failed: 0, unprepared: 0,
  domains: [
    { domain: "location", label: "Location", saved: 1, updated: 0, merged: 0, unchanged: 0 },
    { domain: "ria", label: "RIA", saved: 1, updated: 0, merged: 0, unchanged: 0 },
    { domain: "identity", label: "Identity", saved: 1, updated: 0, merged: 0, unchanged: 0 },
  ],
  items: [
    { id: "home", domainLabel: "Location", text: "My home is 12 Example Street (synthetic).", outcome: "saved" },
    { id: "pick", domainLabel: "RIA", text: "Northwind Capital is one of my advisor picks (synthetic).", outcome: "saved" },
    { id: "legal", domainLabel: "Identity", text: "My legal name is Ada Example (synthetic).", outcome: "saved" },
  ],
  offers: [
    { id: "home", ownerFeature: "location", label: "Add as Home in Location", routePattern: "/one/location",
      actionId: "route.one_location", prefill: { kind: "location_saved_place", category: "home", label: "" } },
    { id: "pick", ownerFeature: "ria", label: "Add Northwind Capital in RIA Picks", routePattern: "/ria/picks",
      actionId: "route.ria_picks", prefill: null },
    { id: "legal", ownerFeature: "kyc", label: "Review legal name in Mail", routePattern: "/one/gmail?workspace=kyc",
      actionId: "route.one_gmail_kyc", prefill: null },
  ],
};

const state = new URLSearchParams(window.location.search).get("state") || "offers";

const [MEMORY_CARD] = buildPkmMemoryCardsFromNode(
  state === "memory-kyc"
    ? {
        domain: "identity",
        domainTitle: "Identity",
        value: { identity_profile: { legal_name: "Ada Example" } },
        sourceLabel: "Saved memory",
        updatedAt: null,
        pathSegments: [],
      }
    : {
        domain: "location",
        domainTitle: "Location",
        value: { saved_places: { home: { label: "Home" } } },
        sourceLabel: "Saved memory",
        updatedAt: null,
        pathSegments: [],
      },
);

function App() {
  return (
    <main className="mx-auto w-full max-w-[40rem] px-4 py-6">
      {state === "memory" || state === "memory-kyc" ? (
        <PkmMemoryDetail
          card={MEMORY_CARD!}
          sharingState="private"
          sharingPosture="private"
          sharingBusy={false}
          sharingError={null}
          canMutate={false}
          saving={false}
          deleting={false}
          actionError={null}
          onBack={() => undefined}
          onSharingChange={() => undefined}
          onSave={() => undefined}
          onForget={() => undefined}
          onOpenOwner={() => undefined}
        />
      ) : (
        <AgentMemorySaveCard receipt={RECEIPT} memoryHref="/one/pkm/recent" onOpenOffer={() => undefined} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
