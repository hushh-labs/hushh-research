import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function PkmViewerPage() {
  return <ClientRedirect to={ROUTES.PKM} />;
}
