import type { Metadata } from "next";

import { LegalDocumentPage } from "@/components/legal/legal-document-page";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";

// Canonical Hussh One Terms of Use. This is the URL to give the Google OAuth
// consent screen and the App Store / Google Play listings.
export const metadata: Metadata = {
  title: "Terms of Use · Hussh One",
  description: LEGAL_DOCUMENTS.terms.summary,
  alternates: { canonical: LEGAL_DOCUMENTS.terms.route },
};

export default function TermsOfUsePage() {
  return <LegalDocumentPage type="terms" />;
}
