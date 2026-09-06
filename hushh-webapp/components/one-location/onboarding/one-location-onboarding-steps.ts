import type { OnboardingStep } from "@/components/app-ui/onboarding-stepper";

export const ONE_LOCATION_ONBOARDING_STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "features", label: "What One Location does" },
  { id: "place", label: "Save a place" },
  { id: "ready", label: "Ready" },
] as const satisfies readonly OnboardingStep[];

export type OneLocationOnboardingScreen =
  (typeof ONE_LOCATION_ONBOARDING_STEPS)[number]["id"];
