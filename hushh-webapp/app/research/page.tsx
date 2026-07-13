import type { Metadata } from "next";
import { ResearchLanding } from "@/components/research/research-landing";

export const metadata: Metadata = {
  title: "Research & Papers · Hushh",
  description:
    "Open protocols and papers from Hushh, donated to the commons. Home of PCHP — the Personal Consent Handshake Protocol.",
};

export default function ResearchPage() {
  return <ResearchLanding />;
}
