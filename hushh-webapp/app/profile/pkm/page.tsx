import { redirect } from "next/navigation";

import { resolveAppEnvironment } from "@/lib/app-env";

export default function PkmViewerPage() {
  if (resolveAppEnvironment() === "production") {
    redirect("/profile?tab=account");
  }
  redirect("/profile/pkm-agent-lab");
}
