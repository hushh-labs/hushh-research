import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";
import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

export default async function LegacyConnectedSystemsPage() {
  await requireLocalCrmRoute();
  redirect(ROUTES.CONNECTED_SYSTEMS);
}
