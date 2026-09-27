import { Suspense } from "react";

import OneGmailPageClient from "@/app/one/gmail/gmail-page-client";
import { GmailWorkspaceSkeleton } from "@/components/gmail/gmail-workspace-skeleton";

export default function OneGmailPage() {
  return (
    <Suspense fallback={<GmailWorkspaceSkeleton titleVisuallyHidden />}>
      <OneGmailPageClient />
    </Suspense>
  );
}
