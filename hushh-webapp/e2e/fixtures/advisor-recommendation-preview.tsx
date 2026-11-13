import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AdvisorRecommendations } from "@/components/kai/advisor/advisor-recommendations";
import { AdvisorRequestFlow } from "@/components/kai/advisor/advisor-request-flow";
import type { AdvisorCandidate } from "@/lib/advisor-review/contract";
import { sharingModel } from "./finance-sharing-boundaries";
import { reviewFixtureContext } from "./advisor-review-boundaries";

const context = reviewFixtureContext(false);

function Preview() {
  const [selected, setSelected] = useState<AdvisorCandidate | null>(null);
  const [sent, setSent] = useState(false);
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-5 py-8 sm:py-12">
      <header className="flex flex-col gap-2">
        <p className="ui-text-helper-text">Finance · Sample preview</p>
        <h1 className="ui-text-page-title">Find your advisor</h1>
        <p className="ui-text-row-description">
          Start with the help you need. Explore advisors who offer it.
        </p>
      </header>
      <section className="flex flex-col items-start gap-4 rounded-2xl border border-border bg-card p-5">
        <p className="ui-text-row-label">
          A shorter path to the right conversation.
        </p>
        <AdvisorRecommendations
          context={context}
          model={sharingModel}
          onChoose={setSelected}
        />
      </section>
      <p className="ui-text-helper-text">
        Sample profiles only. No real introductions are sent.
      </p>
      {sent ? (
        <p role="status">
          Sample request approved. Nothing was sent to a real advisor.
        </p>
      ) : null}
      {selected ? (
        <AdvisorRequestFlow
          context={context}
          source={{ kind: "statement", snapshotId: null }}
          initialAdvisor={selected}
          onClose={() => setSelected(null)}
          onSent={() => {
            setSelected(null);
            setSent(true);
          }}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
