import { redirect } from "next/navigation";

import { resolveAppEnvironment } from "@/lib/app-env";

export default function PkmViewerPage() {
  if (resolveAppEnvironment() === "production") {
    redirect("/profile?panel=my-data");
  }
  redirect("/profile/pkm-agent-lab");
}
