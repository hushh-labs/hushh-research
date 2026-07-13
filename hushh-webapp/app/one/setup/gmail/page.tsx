import { GmailOnboardingSetupClient } from "@/app/one/setup/gmail/gmail-onboarding-setup-client";

/**
 * Physical Gmail setup route.
 *
 * This intentionally owns the setup workspace instead of forwarding to
 * `/one/gmail`, whose normal product chrome includes the bottom navigation.
 */
export default function GmailOnboardingSetupPage() {
  return <GmailOnboardingSetupClient />;
}
