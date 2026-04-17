import { redirect } from "next/navigation";

import { resolveDeveloperRuntime } from "@/lib/developers/runtime";

import PkmAgentLabPageClient from "./page-client";

export default function PkmAgentLabPage() {
  if (resolveDeveloperRuntime().environment !== "local") {
    redirect("/profile?panel=my-data");
  }

  return <PkmAgentLabPageClient />;
}
