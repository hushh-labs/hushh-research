"use client";

import { Suspense } from "react";

import ProfileGmailOAuthReturnPageClient from "./page-client";

export default function ProfileGmailOAuthReturnPage() {
  return (
    <Suspense fallback={null}>
      <ProfileGmailOAuthReturnPageClient
        initialCode=""
        initialState=""
        initialError=""
        initialErrorDescription=""
      />
    </Suspense>
  );
}
