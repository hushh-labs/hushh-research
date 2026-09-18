import type { Metadata } from "next";
import { FounderProfileView } from "@/components/marketing/founder-profile-view";
import { PUBLIC_ROUTE_SEMANTICS } from "@/lib/seo/site";

const SEMANTICS = PUBLIC_ROUTE_SEMANTICS["/manishhussh"];
const AVATAR_URL = "/manish-sainani.png";

export const metadata: Metadata = {
  title: SEMANTICS.title,
  description: SEMANTICS.description,
  openGraph: {
    type: "profile",
    firstName: "Manish",
    lastName: "Sainani",
    title: SEMANTICS.title,
    description: SEMANTICS.description,
    siteName: "Hussh",
    url: "/manishhussh",
    images: [{ url: AVATAR_URL, width: 316, height: 590, alt: "Manish Sainani" }],
  },
  twitter: {
    card: "summary",
    title: SEMANTICS.title,
    description: SEMANTICS.description,
    images: [AVATAR_URL],
  },
};

export default function ManishSainaniProfilePage() {
  return <FounderProfileView />;
}
