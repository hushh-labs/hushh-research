import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiPlaidOauthReturnPage() {
  return <ClientRedirect to={ROUTES.KAI_PLAID_OAUTH_RETURN} />;
}
