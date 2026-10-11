import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportProgressView } from "../../components/kai/views/import-progress-view";
import { DecisionCard } from "../../components/kai/views/decision-card";
import { HoldingRowActions } from "../../components/kai/holdings/holding-row-actions";

function Fixture() {
  const [updated, setUpdated] = useState(false);
  const [action, setAction] = useState("");
  return <main className="mx-auto max-w-3xl p-4">
    <button onClick={() => setUpdated(true)}>Update progress</button>
    <ImportProgressView stage="extracting" isStreaming progressPct={updated ? 77 : undefined}
      statusMessage="Reading your statement"
      rawStreamLines={updated ? Array.from({ length: 15 }, (_, i) => `[THINKING] Processing holding ${i}`) : ["[THINKING] Reading statement"]} />
    <div data-testid="after-import">After import</div>
    <div data-testid="review-scroll" style={{ height: 220, overflow: "auto" }}>
      <HoldingRowActions symbol="TEST" layout="row" onEdit={() => setAction("Edit TEST")} onToggleDelete={() => setAction("Delete TEST")} />
      <div style={{ height: 800 }}>Other holdings</div>
    </div>
    <output data-testid="action-result">{action}</output>
    <DecisionCard result={{ ticker: "TEST", decision: "buy", confidence: 0.82,
      consensus_reached: false, final_statement: "Example verdict",
      agent_votes: { fundamental: "buy", technical: "hold", sentiment: "reduce" },
      dissenting_opinions: ["Example dissent"], raw_card: {} }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
