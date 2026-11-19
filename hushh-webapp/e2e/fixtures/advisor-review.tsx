import { useState } from "react";
import { PortfolioAgentReview } from "@/components/kai/advisor/portfolio-agent-review";
import { PortfolioAnalysis } from "@/components/kai/views/portfolio-briefing";
import { sharingModel } from "./finance-sharing-boundaries";
import { AdvisorWorkspace } from "@/components/kai/advisor/advisor-workspace";
import { AdvisorRequestFlow } from "@/components/kai/advisor/advisor-request-flow";
import { reviewFixtureContext, reviewId } from "./advisor-review-boundaries";

const advisorContext = reviewFixtureContext(true); const ownerContext = reviewFixtureContext(false);
export function AdvisorReviewFixture() {
  const [panel, setPanel] = useState<"request" | "advisor" | "owner" | null>(null);
  return <section><p>Synthetic advisor handshake</p><button onClick={() => { document.body.dataset.advisorStage = "pending"; setPanel("advisor"); }}>Open sample advisor request</button><button onClick={() => { document.body.dataset.advisorStage = "accepted"; document.body.dataset.advisorMeeting = "agreed"; setPanel("advisor"); }}>Open sample agreed meeting</button><button onClick={() => setPanel("request")}>Start sample advisor request</button>
    {panel === "request" ? <AdvisorRequestFlow context={ownerContext} source={{ kind: "statement", snapshotId: null }} onClose={() => setPanel(null)} onSent={() => setPanel("owner")} /> : panel ? <AdvisorWorkspace context={panel === "advisor" ? advisorContext : ownerContext} id={reviewId} onClose={() => setPanel(null)} /> : null}
  </section>;
}

export function PortfolioAnalysisFixture() {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(sharingModel);
  const [advisor, setAdvisor] = useState(false);
  return (
    <section>
      <button onClick={() => setOpen((previous) => !previous)}>Toggle sample analysis</button>
      <button onClick={() => {
        document.body.dataset.portfolioReviewChanged = "true";
        setModel({ ...sharingModel, hero: { ...sharingModel.hero, totalValue: 12000 } });
      }}>Update sample portfolio</button>
      {open ? (
        <>
          <PortfolioAgentReview context={ownerContext} source={{ kind: "statement", snapshotId: null }}
            model={model} scope="synthetic-epoch" personaRevision={0} onFindAdvisor={() => setAdvisor(true)} />
          <PortfolioAnalysis model={model} source="Sample statement" />
          {advisor ? <AdvisorRequestFlow context={ownerContext} source={{ kind: "statement", snapshotId: null }}
            onClose={() => setAdvisor(false)} onSent={() => setAdvisor(false)} /> : null}
        </>
      ) : null}
    </section>
  );
}
