import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiFundingTradePage() {
  return <ClientRedirect to={ROUTES.KAI_FUNDING_TRADE} />;
}
