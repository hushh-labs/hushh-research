import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiOnboardingPage() {
  return <ClientRedirect to={ROUTES.ONE_SETUP_KAI} />;
}
