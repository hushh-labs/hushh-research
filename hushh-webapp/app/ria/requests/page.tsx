import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function RiaRequestsCompatibilityPage() {
  return <ClientRedirect to={ROUTES.CONSENTS} />;
}
