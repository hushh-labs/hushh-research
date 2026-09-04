import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

/** Compatibility destination for existing regulatory-profile links. */
export default function ProfileRegulatoryCompatibilityPage() {
  return <ClientRedirect to={ROUTES.RIA_PROFILE} />;
}
