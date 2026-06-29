import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function OneKaiOnboardingCompatibilityPage() {
  redirect(ROUTES.ONE_ONBOARDING);
}
