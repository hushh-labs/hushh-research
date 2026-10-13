import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiFundingTradePage() {
  redirect(ROUTES.KAI_FUNDING_TRADE);
}
