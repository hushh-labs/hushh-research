import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";

// The RIA advisor profile now lives inside the unified /one/profile section under the
// "Regulatory profile" panel (same UI/UX + edit/delete/re-initiate/license logic).
// This legacy route redirects there so direct links and older flows stay working.
export default function RiaProfileRedirectPage() {
  return <ClientRedirect to={buildProfileRoute({ panel: "regulatory" })} />;
}
