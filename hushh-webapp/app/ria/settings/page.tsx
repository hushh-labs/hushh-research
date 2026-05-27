import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function RiaSettingsCompatibilityPage() {
  return <ClientRedirect to={ROUTES.PROFILE} />;
}
