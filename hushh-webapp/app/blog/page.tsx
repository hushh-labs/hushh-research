import type { Metadata } from "next";
import { BlogIndex } from "@/components/research/blog-index";

export const metadata: Metadata = {
  title: "Blog · Hushh Research",
  description:
    "Writing on consent-first information sharing, the Personal Consent Handshake Protocol, and working backwards from the human — by Manish Sainani and the 🤫 Research & Intelligence Team.",
};

export default function BlogPage() {
  return <BlogIndex />;
}
