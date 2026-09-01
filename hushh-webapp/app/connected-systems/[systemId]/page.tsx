import { redirect } from "next/navigation";

import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

export function generateStaticParams() {
  return [{ systemId: "salesforce-fsc-customer0" }];
}

export default async function LegacyConnectedSystemDetailPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  await requireLocalCrmRoute();
  const { systemId } = await params;
  redirect(buildConnectedSystemRoute(systemId));
}
