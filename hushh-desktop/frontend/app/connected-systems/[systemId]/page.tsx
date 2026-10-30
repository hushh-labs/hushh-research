import { redirect } from "next/navigation";

import { buildConnectedSystemRoute } from "@/lib/navigation/routes";

export function generateStaticParams() {
  return [{ systemId: "salesforce-fsc-customer0" }];
}

export default async function LegacyConnectedSystemDetailPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  redirect(buildConnectedSystemRoute(systemId));
}
