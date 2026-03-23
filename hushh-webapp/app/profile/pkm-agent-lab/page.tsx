import { redirect } from "next/navigation";

import { resolveAppEnvironment } from "@/lib/app-env";

import PkmAgentLabPageClient from "./page-client";

export default function PkmAgentLabPage() {
  if (resolveAppEnvironment() === "production") {
    redirect("/profile?tab=account");
  }

  return <PkmAgentLabPageClient />;
}
