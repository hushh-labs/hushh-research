import { CalendarOnboardingSetupClient } from "@/app/one/setup/calendar/calendar-onboarding-setup-client";

/** Physical Calendar setup route; it owns the setup completion boundary. */
export default function CalendarOnboardingSetupPage() {
  return <CalendarOnboardingSetupClient />;
}
