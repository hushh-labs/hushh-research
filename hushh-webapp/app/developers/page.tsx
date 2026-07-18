import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { buildPublicKnowledgeRoute } from "@/lib/navigation/top-shell-tabs";

export const metadata: Metadata = {
  title: "Developers · Hussh",
  description:
    "Build consent-first agent experiences with Hussh protocols and developer tools.",
};

export default function DevelopersPage() {
  redirect(buildPublicKnowledgeRoute("developers"));
}
