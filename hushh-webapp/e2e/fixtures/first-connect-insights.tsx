import { createRoot } from "react-dom/client";
import { useState } from "react";
import { FirstConnectInsightsCard } from "../../components/agent/first-connect-insights-card";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";
publishValidatedAuthSessionOwner("fixture-owner");
function Fixture() {
  const [prompt, setPrompt] = useState("");
  return (
    <main className="mx-auto max-w-xl p-4">
      <FirstConnectInsightsCard ownerId="fixture-owner" vaultKey="synthetic-key" vaultOwnerToken="synthetic-token" enabled onPromptSelect={setPrompt} />
      <p role="status">{prompt}</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
