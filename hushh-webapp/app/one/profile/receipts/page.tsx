import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyProfileReceiptsPage() {
  return <ClientRedirect to={ROUTES.GMAIL} />;
}
