"use client";

/**
 * Profile Layout
 * 
 * Profile page allows sign out even when vault is locked.
 * Existing vault users stay unblocked here; no-vault users still satisfy the
 * post-login phone mandate before the broader app flow continues.
 */

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PhoneMandateGuard exemptVaultUsers>{children}</PhoneMandateGuard>;
}
