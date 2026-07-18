import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { buildPublicKnowledgeRoute } from "@/lib/navigation/top-shell-tabs";

export const metadata: Metadata = {
  title: "Research & Papers · Hushh",
  description:
    "Open protocols and papers from Hushh, donated to the commons. Home of PCHP — the Personal Consent Handshake Protocol.",
};

export default function ResearchPage() {
  redirect(buildPublicKnowledgeRoute("research"));
}
