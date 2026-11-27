import type { OnboardingStep } from "@/components/app-ui/onboarding-stepper";

export const LOCATION_ONBOARDING_CIRCLE_TITLE = "Find your circle";

export const ONE_LOCATION_ONBOARDING_STEPS = [
  { id: "features", label: "Your place" },
  { id: "ready", label: LOCATION_ONBOARDING_CIRCLE_TITLE },
] as const satisfies readonly OnboardingStep[];

export type OneLocationOnboardingScreen =
  (typeof ONE_LOCATION_ONBOARDING_STEPS)[number]["id"];
