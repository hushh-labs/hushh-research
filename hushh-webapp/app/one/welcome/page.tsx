import { Suspense } from "react";
import { InitialContactsWelcome } from "@/components/onboarding/initial-contacts-welcome";
import { HushhLoader } from "@/components/app-ui/hushh-loader";

export default function OneWelcomePage() {
  return <Suspense fallback={<HushhLoader variant="page" />}><InitialContactsWelcome /></Suspense>;
}
