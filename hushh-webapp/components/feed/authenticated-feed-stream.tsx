"use client";

import { useAuth } from "@/hooks/use-auth";
import { useDocumentFeedStream } from "@/lib/feed/use-document-feed-stream";

/** App lifetime, above route pages: badges and open requests receive remote changes. */
export function AuthenticatedFeedStream() {
  const { user, loading, sessionVerificationRequired } = useAuth();
  useDocumentFeedStream(!loading && !sessionVerificationRequired ? user : null);
  return null;
}
