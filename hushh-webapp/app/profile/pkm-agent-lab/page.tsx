import { redirect } from "next/navigation";

import { resolveDeveloperRuntime } from "@/lib/developers/runtime";
import { ROUTES } from "@/lib/navigation/routes";

import PkmAgentLabPageClient from "./page-client";

export default function PkmAgentLabPage() {
  if (resolveDeveloperRuntime().environment !== "local") {
    redirect(ROUTES.PKM);
  }

  return <PkmAgentLabPageClient />;
}
