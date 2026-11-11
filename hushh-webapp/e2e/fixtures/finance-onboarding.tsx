import { FinanceOnboardingPages } from "../../components/kai/onboarding/finance-onboarding-pages";
import { useState } from "react";
import { FullscreenFlowShell } from "../../components/app-ui/fullscreen-flow-shell";
import {
  FinanceOnboardingComplete,
  FinanceOnboardingDemo,
} from "../../components/kai/onboarding/finance-onboarding";
import { FinancePersonaForm } from "../../components/kai/onboarding/finance-persona-form";
import { PortfolioImportView } from "../../components/kai/views/portfolio-import-view";

/** Production UI with synthetic import transport; never opens a bank or saves owner data. */
export function FinanceOnboardingFixture() {
  const [phase, setPhase] = useState<
    "demo" | "persona" | "source" | "complete"
  >("demo");
  const [busy, setBusy] = useState(false);
  const record = (action: string) => {
    document.body.dataset.sourceAction = action;
    setBusy(true);
  };
  return (
    <main>
      <FullscreenFlowShell
        width="agent"
        className="relative px-[var(--page-inline-gutter-standard)] pb-6"
      >
        <FinanceOnboardingPages
          stage={["demo", "persona", "source", "complete"].indexOf(phase)}
        >
          {phase === "demo" ? (
            <FinanceOnboardingDemo onContinue={() => setPhase("persona")} />
          ) : phase === "persona" ? (
            <FinancePersonaForm
              onboarding
              onSave={async () => {}}
              onDone={() => setPhase("source")}
            />
          ) : phase === "source" ? (
            <PortfolioImportView
              presentation="onboarding"
              onSetupBack={() => setPhase("persona")}
              onSkip={() => setPhase("complete")}
              onFileSelect={() => record("statement")}
              onConnectPlaid={() => record("plaid")}
              onPreloadSchema={() => record("sample")}
              isConnectingPlaid={busy}
            />
          ) : (
            <FinanceOnboardingComplete
              deferred
              rootSetup={false}
              busy={false}
              onFinish={() => {
                document.body.dataset.finished = "true";
              }}
            />
          )}
        </FinanceOnboardingPages>
      </FullscreenFlowShell>
    </main>
  );
}
