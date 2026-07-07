import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiAlpacaOauthReturnPage() {
  return <ClientRedirect to={ROUTES.KAI_ALPACA_OAUTH_RETURN} />;
}
