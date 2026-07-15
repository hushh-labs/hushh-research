import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";

export default function RiaSettingsCompatibilityPage() {
  return <ClientRedirect to={buildProfileRoute({ panel: "regulatory" })} />;
}
