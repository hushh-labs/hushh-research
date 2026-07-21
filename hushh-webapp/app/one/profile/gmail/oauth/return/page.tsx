"use client";

import { Suspense } from "react";

import ProfileGmailOAuthReturnPageClient from "@/app/profile/gmail/oauth/return/page-client";

function GmailOAuthReturnFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-center text-foreground">
      <p className="text-sm font-medium text-muted-foreground">
        Completing your Gmail connector setup...
      </p>
    </div>
  );
}

export default function ProfileGmailOAuthReturnPage() {
  return (
    <Suspense fallback={<GmailOAuthReturnFallback />}>
      <ProfileGmailOAuthReturnPageClient
        initialCode=""
        initialState=""
        initialError=""
        initialErrorDescription=""
      />
    </Suspense>
  );
}
