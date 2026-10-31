import { createRoot } from "react-dom/client";
import { AgentMemorySaveCard } from "../../components/agent/agent-memory-save-card";
import type { PkmSaveReceipt, PkmSaveReceiptCoverageLine } from "../../lib/agent/pkm-save-receipt";
import type { AgentPkmPreviewCard } from "../../lib/agent/agent-pkm-memory";

/**
 * The explicit-save receipt card, every value synthetic. `?state=` picks the
 * receipt; nothing here touches the network or a vault.
 */
const FULL: PkmSaveReceipt = {
  saved: 42, updated: 6, merged: 3, unchanged: 4, skipped: 2, excluded: 0, unreadable: 0, needsOwner: 2, failed: 0, unprepared: 1,
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

const saved = (domainLabel: string, path: string) => [{ domainLabel, path, commitId: "commit_synthetic" }];
const LINES: PkmSaveReceiptCoverageLine[] = [
  { line: 1, text: "Personal context transfer for One (synthetic)", status: "saved", savedTo: saved("Identity", "Profile > Title") },
  { line: 3, text: "Core stack", status: "structure", reason: "heading", savedTo: [] },
  { line: 4, text: "Stack item 1: synthetic tool 1 for layer 1", status: "saved", savedTo: saved("Work context", "Stack > Item 1") },
  { line: 5, text: "Stack item 2: synthetic tool 2 for layer 2", status: "saved", savedTo: saved("Work context", "Stack > Item 2") },
  { line: 6, text: "Background: the synthetic team ships weekly, reviews every change twice, and keeps a written log of each release decision for later reading.", status: "saved", savedTo: saved("Work context", "Practices > Release cadence") },
  { line: 7, text: "Food fact 2: synthetic detail 2 for Food", status: "not_memory", reason: "already_known", savedTo: [] },
  { line: 8, text: "Housing fact 1: synthetic detail 1 for Housing", status: "not_memory", reason: "duplicate", savedTo: [] },
  { line: 9, text: "Passport number on file (synthetic)", status: "held", reason: "needs_owner", savedTo: [], heldCardIds: ["pending-1"] },
  { line: 10, text: "Vendors fact 3: synthetic detail 3 for Vendors", status: "not_yet_saved", savedTo: [] },
  { line: 11, text: "Vendors fact 4: synthetic detail 4 for Vendors", status: "not_yet_saved", savedTo: [] },
  { line: 13, text: "Information not known", status: "structure", reason: "heading", savedTo: [] },
  { line: 14, text: "Exact home street address", status: "not_memory", reason: "disclaimer", savedTo: [] },
];
const COVERAGE: PkmSaveReceipt = {
  ...FULL,
  coverage: {
    jobId: "job-synthetic", jobState: "completed_with_gaps", totalLines: 12, accountedLines: 9, savedLines: 4,
    notMemoryLines: 3, structureLines: 2, heldLines: 1, notYetSavedLines: 2, lines: LINES,
  },
};

const STATES: Record<string, PkmSaveReceipt> = {
  full: FULL,
  coverage: COVERAGE,
  unchanged: {
    ...FULL, saved: 0, updated: 0, merged: 0, unchanged: 51, skipped: 2, needsOwner: 0, unprepared: 0,
    domains: [], items: [],
  },
};

const state = new URLSearchParams(window.location.search).get("state") || "full";
const PENDING: AgentPkmPreviewCard[] = [
  { card_id: "pending-1", source_text: "Synthetic identity detail requiring review", write_mode: "confirm_first", target_domain: "identity", candidate_payload: {} },
  { card_id: "pending-2", source_text: "Synthetic shared detail requiring review", write_mode: "confirm_first", target_domain: "profile", candidate_payload: {} },
];

function App() {
  return (
    <main className="mx-auto w-full max-w-[40rem] px-4 py-6">
      <AgentMemorySaveCard
        receipt={STATES[state] ?? FULL}
        memoryHref="/pkm/recent"
        onConfirmNeedsOwner={async () => undefined}
        onRetry={state === "coverage" ? async () => undefined : undefined}
        pendingCards={state === "unchanged" ? [] : PENDING}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
