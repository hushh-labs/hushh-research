import { FinanceImportOnboardingSetupClient } from "./import/finance-import-onboarding-setup-client";

/** Capture starter investing preferences before portfolio source selection. */
export default function FinanceOnboardingSetupPage() {
  return <FinanceImportOnboardingSetupClient startWithPersona />;
}
