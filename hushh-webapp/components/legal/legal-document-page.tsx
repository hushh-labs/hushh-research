"use client";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { LegalReader } from "@/components/legal/legal-reader";
import {
  LEGAL_DOCUMENTS,
  type LegalDocumentType,
} from "@/lib/legal/legal-documents";

// Public and signed-out safe: linked from sign-in, the Google OAuth consent
// screen and the store listings, so it must render for someone who has never
// opened the app. It sits in the app's own shell, so the top bar owns Back
// (see the /terms and /privacy entries in top-shell-breadcrumbs.ts) and the
// page reads like every other screen. Signed in, Profile opens the same
// reader in place instead of sending people here.
export function LegalDocumentPage({ type }: { type: LegalDocumentType }) {
  const doc = LEGAL_DOCUMENTS[type];

  return (
    <AppPageShell
      as="main"
      // The app's narrow column (as Profile): legal prose stays at a readable
      // line length on wide screens instead of the 54rem reading width.
      width="narrow"
      fitContent
      data-testid={`legal-${type}-page`}
    >
      <AppPageHeaderRegion>
        <PageHeader title={doc.title} description={doc.summary} />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <LegalReader
          type={type}
          navigation={{ kind: "route" }}
          anchorOffset="calc(var(--app-top-content-offset, 0px) + 16px)"
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
