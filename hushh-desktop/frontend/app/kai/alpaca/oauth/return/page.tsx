import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiAlpacaOauthReturnPage() {
  redirect(ROUTES.KAI_ALPACA_OAUTH_RETURN);
}
