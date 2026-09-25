import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DocumentShareReview } from "../../components/consent/document-share-review";
import { DocumentRequestButton } from "../../components/consent/document-request-button";
import { SettingsDetailPanel } from "../../components/app-ui/settings-ui";
import { setFixtureLocked } from "./document-share-boundaries";
const reconcile = () => {};
function Fixture() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <main className="min-h-dvh bg-background p-4 text-foreground">
      <DocumentRequestButton personRef="33333333-3333-4333-8333-333333333333" personName="A" />
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
