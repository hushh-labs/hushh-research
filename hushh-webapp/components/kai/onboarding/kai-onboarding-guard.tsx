/**
 * Compatibility names for the single app-wide onboarding admission gate.
 * New layouts must not mount another copy; `app/providers.tsx` owns it once.
 */
export {
  OnboardingJourneyGuard as OneOnboardingGuard,
  OnboardingJourneyGuard as KaiOnboardingGuard,
} from "@/components/onboarding/onboarding-journey-guard";
