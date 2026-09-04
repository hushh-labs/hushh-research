import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { buildPublicKnowledgeRoute } from "@/lib/navigation/top-shell-tabs";

export const metadata: Metadata = {
  title: "Blog · Hussh Research",
  description:
    "Writing on consent-first information sharing, the Personal Consent Handshake Protocol, and working backwards from the human — by Manish Sainani and the 🤫 Research & Intelligence Team.",
};

export default function BlogPage() {
  redirect(buildPublicKnowledgeRoute("blog"));
}
