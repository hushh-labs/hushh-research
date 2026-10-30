import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildRiaConsentManagerHref } from "@/lib/consent/consent-sheet-route";

export default function RiaRequestsCompatibilityPage() {
  return <ClientRedirect to={buildRiaConsentManagerHref("pending")} />;
}
