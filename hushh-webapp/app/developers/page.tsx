import type { Metadata } from "next";
import { DeveloperDocsHub } from "@/components/developers/developer-docs-hub";

export const metadata: Metadata = {
  title: "Developers · Hussh",
  description:
    "Build consent-first agent experiences with Hussh protocols and developer tools.",
};

export default function DevelopersPage() {
  return <DeveloperDocsHub />;
}
