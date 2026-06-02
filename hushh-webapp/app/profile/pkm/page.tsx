import { ClientRedirect } from "@/components/navigation/client-redirect";
import { resolveAppEnvironment } from "@/lib/app-env";

export default function PkmViewerPage() {
  const target =
    resolveAppEnvironment() === "production"
      ? "/profile?panel=my-data"
      : "/profile/pkm-agent-lab";

  return <ClientRedirect to={target} />;
}
