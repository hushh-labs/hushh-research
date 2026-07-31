import type { Metadata } from "next";
import { PchpSpecView } from "@/components/research/pchp-spec-view";

export const metadata: Metadata = {
  title: "PCHP Specification · Hushh Research",
  description:
    "The Personal Consent Handshake Protocol (PCHP) — an open standard for sharing personal information with consent and control built into every transaction. Public request for comments.",
};

export default function PchpSpecPage() {
  return <PchpSpecView />;
}
