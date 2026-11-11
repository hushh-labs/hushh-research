import { useState } from "react";
import { dispatchLocalPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import { AdvisorReviewHub } from "@/components/kai/advisor/advisor-review-hub";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { sharingModel } from "./finance-sharing-boundaries";
import { AdvisorWorkspace } from "@/components/kai/advisor/advisor-workspace";
import { AdvisorRequestFlow } from "@/components/kai/advisor/advisor-request-flow";
import { reviewFixtureContext, reviewId } from "./advisor-review-boundaries";

const advisorContext = reviewFixtureContext(true); const ownerContext = reviewFixtureContext(false);
export function AdvisorReviewFixture() {
  const [panel, setPanel] = useState<"request" | "advisor" | "owner" | null>(null);
  return <section><p>Synthetic advisor handshake</p><button onClick={() => { document.body.dataset.advisorStage = "pending"; setPanel("advisor"); }}>Open sample advisor request</button><button onClick={() => { document.body.dataset.advisorStage = "accepted"; document.body.dataset.advisorMeeting ??= "agreed"; setPanel("advisor"); }}>Open sample agreed meeting</button><button onClick={() => setPanel("request")}>Start sample advisor request</button>
    <button onClick={() => { document.body.dataset.advisorStage ??= "pending"; setPanel("owner"); }}>
      Open sample outgoing request
    </button>
    {panel === "request" ? <AdvisorRequestFlow context={ownerContext} source={{ kind: "statement", snapshotId: null }} onClose={() => setPanel(null)} onSent={() => setPanel("owner")} /> : panel ? <AdvisorWorkspace context={panel === "advisor" ? advisorContext : ownerContext} id={reviewId} onClose={() => setPanel(null)} /> : null}
  </section>;
}

export function PortfolioAnalysisFixture() {
  const [open, setOpen] = useState(false);
  return (
    <section className={financeStyles.workspace}>
      <button onClick={() => setOpen((previous) => !previous)}>Toggle sample analysis</button>
      <button onClick={() => {
        document.body.dataset.portfolioReviewChanged = "true";
        dispatchLocalPkmDomainChanged({
          userId: "synthetic-owner", domain: "financial", operation: "stored", dataVersion: 2, updatedAt: null,
        });
      }}>Update sample portfolio</button>
      {open ? (
        <AdvisorReviewHub
          model={sharingModel}
          source={{ kind: "statement", snapshotId: null }}
        />
      ) : null}
    </section>
  );
}
