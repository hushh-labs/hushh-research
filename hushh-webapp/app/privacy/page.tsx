import type { Metadata } from "next";

import { LegalDocumentPage } from "@/components/legal/legal-document-page";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";

// Canonical Hussh One Privacy Policy. This is the URL to give the Google OAuth
// consent screen and the App Store / Google Play listings.
export const metadata: Metadata = {
  title: "Privacy Policy · Hussh One",
  description: LEGAL_DOCUMENTS.privacy.summary,
  alternates: { canonical: LEGAL_DOCUMENTS.privacy.route },
};

export default function PrivacyPolicyPage() {
  return <LegalDocumentPage type="privacy" />;
}
