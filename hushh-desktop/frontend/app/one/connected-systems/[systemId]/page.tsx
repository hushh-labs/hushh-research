import { ConnectedSystemDetailClient } from "@/app/one/connected-systems/[systemId]/connected-system-detail-client";

export function generateStaticParams() {
  return [{ systemId: "salesforce-fsc-customer0" }];
}

export default async function ConnectedSystemDetailPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  return <ConnectedSystemDetailClient systemId={systemId} />;
}
