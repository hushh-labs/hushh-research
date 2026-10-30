import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DocumentShareReview } from "../../components/consent/document-share-review";
import { DocumentRequestButton } from "../../components/consent/document-request-button";
import { RequestScopeButton } from "../../components/consent/request-scope-button";
import { DocumentRequestPricingCard } from "../../components/consent/document-request-pricing-card";
import { ScopeCommerceOwnerReview } from "../../components/consent/scope-commerce-owner-review";
import { SettingsDetailPanel } from "../../components/app-ui/settings-ui";
import { setFixtureLocked } from "./document-share-boundaries";
const reconcile = () => {};
function Fixture() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [draft, setDraft] = useState("");
  const [pricingOpen, setPricingOpen] = useState(false);
  const [price, setPrice] = useState("10");
  const [costReview, setCostReview] = useState(false);
  return (
    <main className="min-h-dvh bg-background p-4 text-foreground">
      <DocumentRequestButton personRef="33333333-3333-4333-8333-333333333333" personName="A" />
      <RequestScopeButton personRef="33333333-3333-4333-8333-333333333333" personName="Asha" />
      <button onClick={() => setPricingOpen(true)}>Review default request price</button>
      <button onClick={() => setCostReview(true)}>Review processing costs</button>
      {costReview ? <section aria-label="Processing cost review" className="consent-presentation-surface mx-auto max-w-lg p-4">
        <ScopeCommerceOwnerReview busy={false} unlocked prepare={async acknowledgement => {
          // A presentation fixture has no export or payment authority.
          document.body.dataset.costAcknowledgement = acknowledgement?.binding;
        }} request={{
          request_id: "synthetic-commerce-request", role: "owner", machine_scope: "attr.food.preferences.*",
          scope_handle: "synthetic-food-handle", duration_seconds: 86400, purpose: "Synthetic purpose", tariff: null,
          purchase: { id: "synthetic-purchase", request_id: "synthetic-commerce-request", status: "reserved", amount_cents: 1,
            processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 },
          negative_net_acknowledgement: { version: 1, binding: "synthetic-cost-binding", gross_cents: 1,
            processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 },
        }} />
      </section> : null}
      {pricingOpen ? <div className="profile-pane-scroll-root"><div className="app-page-shell"><div data-profile-stack-content="true">
        <DocumentRequestPricingCard model={{
          available: true, saved: { enabled: true, amountCents: 1000, version: 1 },
          dollars: price, loading: false, saving: false, error: null, notice: null,
          amountCents: Number(price) * 100, dirty: price !== "10",
          change: setPrice, retry: () => {}, save: async () => {},
        }} />
      </div></div></div> : null}
      <button className="min-h-11" onClick={() => setOpen(true)}>
        Review document request
      </button>
      <button className="min-h-11" onClick={() => setFixtureLocked(false)}>
        Unlock test vault
      </button>
      <button className="min-h-11" onClick={() => setSent(true)}>
        Show sent request
      </button>
      {sent ? (
        // The chat host is already a card; the review renders flat inside it.
        <section
          aria-label="Sent request card"
          className="mt-4 rounded-[24px] border border-border/60 bg-background/70 p-4"
        >
          {/* No surface prop: the chat hosts rely on the default. */}
          <DocumentShareReview
            requestId="44444444-4444-4444-8444-444444444444"
            onChanged={reconcile}
          />
        </section>
      ) : null}
      <label>
        Chat draft
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <SettingsDetailPanel
        title="Document request"
        description="Google Drive"
        open={open}
        onOpenChange={setOpen}
        mobilePresentation="sheet"
        bodyClassName="bg-[color:var(--app-grouped-background)]"
      >
        <button className="min-h-11" onClick={() => setFixtureLocked(true)}>
          Lock test vault
        </button>
        <DocumentShareReview
          requestId="11111111-1111-4111-8111-111111111111"
          onChanged={reconcile}
          surface="sheet"
        />
      </SettingsDetailPanel>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
