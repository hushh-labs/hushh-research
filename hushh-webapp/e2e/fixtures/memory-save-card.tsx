import { createRoot } from "react-dom/client";
import { AgentMemorySaveCard } from "../../components/agent/agent-memory-save-card";
import type { PkmSaveReceipt } from "../../lib/agent/pkm-save-receipt";

/**
 * The explicit-save receipt card, every value synthetic. `?state=` picks the
 * receipt; nothing here touches the network or a vault.
 */
const FULL: PkmSaveReceipt = {
  saved: 42, updated: 6, merged: 3, unchanged: 4, skipped: 2, needsOwner: 2, failed: 0, unprepared: 1,
  domains: [
    { domain: "career", label: "Career", saved: 11, updated: 3, merged: 1, unchanged: 1 },
    { domain: "company_context", label: "Company context", saved: 14, updated: 1, merged: 2, unchanged: 2 },
    { domain: "immigration", label: "Immigration", saved: 3, updated: 1, merged: 0, unchanged: 0 },
    { domain: "housing", label: "Housing", saved: 2, updated: 1, merged: 0, unchanged: 1 },
    { domain: "tools_and_vendors", label: "Tools and vendors", saved: 12, updated: 0, merged: 0, unchanged: 0 },
  ],
  items: [
    { id: "1", domainLabel: "Career", text: "Staff engineer at Example Labs since 2025 (synthetic).", outcome: "updated" },
    { id: "2", domainLabel: "Career", text: "Base pay USD 100,000 a year (synthetic).", outcome: "updated" },
    { id: "3", domainLabel: "Immigration", text: "Work visa renewal due in 2027 (synthetic).", outcome: "saved" },
    { id: "4", domainLabel: "Housing", text: "Rents a two-bedroom apartment in Synthetic City.", outcome: "saved" },
    { id: "5", domainLabel: "Tools and vendors", text: "Uses Linear and Figma daily.", outcome: "merged" },
    { id: "6", domainLabel: "Identity", text: "Passport number on file (synthetic).", outcome: "needs_owner" },
  ],
};

const STATES: Record<string, PkmSaveReceipt> = {
  full: FULL,
  unchanged: {
    ...FULL, saved: 0, updated: 0, merged: 0, unchanged: 51, skipped: 2, needsOwner: 0, unprepared: 0,
    domains: [], items: [],
  },
};

const state = new URLSearchParams(window.location.search).get("state") || "full";

function App() {
  return (
    <main className="mx-auto w-full max-w-[40rem] px-4 py-6">
      <AgentMemorySaveCard
        receipt={STATES[state] ?? FULL}
        memoryHref="/pkm/recent"
        onConfirmNeedsOwner={async () => undefined}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
