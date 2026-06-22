import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiPlaidOauthReturnPage() {
  redirect(ROUTES.KAI_PLAID_OAUTH_RETURN);
}
