"use client";

/**
 * Profile Layout
 * 
 * Profile page allows sign out even when vault is locked.
 * Vault protection is handled at the API call level (PKM data requires vaultOwnerToken).
 */

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
