import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  SharedWithYouCardView,
  type SharedWithYouCardStatus,
  type SharedWithYouItemView,
} from "../../components/agent/consent/shared-with-you-card-view";
import { AskProposalCard } from "../../components/agent/consent/ask-proposal-card";
import type { RequestablePersonScope } from "../../lib/services/person-profile-service";

/**
 * Every state of the secure "Shared with you" card (the same component chat,
 * Profile and the person page render), and the ask card's selectable rows.
 * Values are synthetic. Nothing here touches the network.
 */
const PERSON = { displayName: "Manish Sainani", photoUrl: null };
const SHARED = "2026-09-28T10:00:00Z";
const UNTIL = "2026-10-05T12:00:00Z";

const TAX: SharedWithYouItemView = {
  key: "tax", label: "Tax record", sharedAt: SHARED, accessEndsAt: UNTIL,
  purpose: "Preparing the joint return", sensitive: true,
  fieldOutline: ["Ein", "Filing form", "Form 8655 signed", "Taxpayer type"], state: "ready",
  data: { federal: { ein: "00-0000000", filing_form: "Form 941", form_8655_signed: true, tax_payer_type: "C-Corporation" } },
};
const FOOD: SharedWithYouItemView = {
  key: "food", label: "Food preferences", sharedAt: SHARED, accessEndsAt: UNTIL, purpose: null, sensitive: false,
  fieldOutline: ["Cuisine", "Diet"], state: "ready",
  data: { cuisine: "Neapolitan pizza", diet: "Vegetarian", notes: "Prefers a quiet table away from the kitchen and books ahead on weekends." },
};

/** A standard item holding an identifier field (run 4, S3): the EIN alone is marked. */
const LEGAL_ENTITY: SharedWithYouItemView = {
  key: "legal", label: "Legal entity", sharedAt: SHARED, accessEndsAt: UNTIL, purpose: null, sensitive: false,
  fieldOutline: ["Federal EIN", "Trade name"], state: "ready",
  data: { fein: "00-0000000", trade_name_dba: "Acme Coffee", entity_type: "C_CORP" },
};

const STATES: Array<{ state: string; status: SharedWithYouCardStatus; items: SharedWithYouItemView[]; variant?: "chat" | "profile" }> = [
  { state: "decrypted", status: "ready", items: [TAX, FOOD] },
  { state: "loading", status: "loading", items: [{ ...TAX, state: "loading", data: null }] },
  { state: "locked", status: "locked", items: [{ ...TAX, state: "locked", data: null }, { ...FOOD, state: "locked", data: null }] },
  { state: "ended", status: "ready", items: [{ ...TAX, state: "ended", endedReason: "revoked", data: null }] },
  { state: "error", status: "error", items: [TAX] },
  { state: "unopenable", status: "ready", items: [{ ...TAX, label: "Tax record information", state: "unopenable", data: null }] },
  { state: "profile", status: "ready", items: [TAX, FOOD], variant: "profile" },
  { state: "legal", status: "ready", items: [LEGAL_ENTITY] },
];

const LEGAL: RequestablePersonScope[] = [
  { scopeRef: "scope-legal", label: "Legal Entity Domain", description: null, domain: "legal_entity", sensitivity: "standard", wildcard: true, pathSegments: [] },
  { scopeRef: "scope-entity", label: "Entity", description: null, domain: "legal_entity", sensitivity: "standard", wildcard: false, pathSegments: ["entity"] },
  { scopeRef: "scope-ein", label: "Employer id", description: null, domain: "legal_entity", sensitivity: "sensitive", wildcard: false, pathSegments: ["ein"] },
  { scopeRef: "scope-address", label: "Registered address", description: null, domain: "legal_entity", sensitivity: "standard", wildcard: false, pathSegments: ["address"] },
];
const PROPOSAL = {
  proposed: [
    { scopeRef: "scope-legal", label: "Legal Entity Domain", why: "Matches what you asked for" },
    { scopeRef: "scope-entity", label: "Entity", why: null },
  ],
  durationHours: 168,
  reasonSuggestion: "Setting up the company account",
};

function Ask() {
  const [sent, setSent] = useState<string[] | null>(null);
  return (
    <>
      <AskProposalCard personName="Manish Sainani" proposal={PROPOSAL} ready sending={false} error={null}
        catalog={LEGAL} onSend={(draft) => setSent(draft.scopes.map((scope) => scope.scopeRef))}
        searchCatalog={async () => ({ scopes: [], page: 1, hasMore: false, nextPage: null, totalCount: 0 })} />
      {sent ? <output data-testid="ask-sent">{sent.join(",")}</output> : null}
    </>
  );
}

function Fixture() {
  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <section data-state="chat" aria-label="chat">
          <p className="mb-3 text-[15px] leading-6 text-foreground">Here’s what Manish shared with you:</p>
          <SharedWithYouCardView person={PERSON} status="ready" items={[TAX]} />
        </section>
        {STATES.map(({ state, status, items, variant }) => (
          <section key={state} data-state={state} aria-label={state}>
            <SharedWithYouCardView person={PERSON} status={status} items={items} variant={variant}
              onUnlock={() => undefined} onRetry={() => undefined} />
          </section>
        ))}
        <section data-state="ask" aria-label="ask"><Ask /></section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
