import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DocumentShareReview } from "../../components/consent/document-share-review";
import { SettingsDetailPanel } from "../../components/app-ui/settings-ui";
import { setFixtureLocked } from "./document-share-boundaries";
const reconcile = () => {};
function Fixture() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <main className="min-h-dvh bg-background p-4 text-foreground">
      <button className="min-h-11" onClick={() => setOpen(true)}>
        Review document request
      </button>
      <button className="min-h-11" onClick={() => setFixtureLocked(false)}>
        Unlock test vault
      </button>
      <label>
        Chat draft
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <SettingsDetailPanel
        title="Document request"
        description="Review exact files and recorded access."
        open={open}
        onOpenChange={setOpen}
        mobilePresentation="sheet"
      >
        <button className="min-h-11" onClick={() => setFixtureLocked(true)}>
          Lock test vault
        </button>
        <DocumentShareReview
          requestId="11111111-1111-4111-8111-111111111111"
          onChanged={reconcile}
        />
      </SettingsDetailPanel>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
