"use client";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { VaultMethodPrompt } from "@/components/vault/vault-method-prompt";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useVault } from "@/lib/vault/vault-context";
import { setIalphabetsVaultOwnerToken } from "@/lib/services/ialphabets-service";

export default function IalphabetsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { vaultOwnerToken } = useVault();
  const isJoinPreview = pathname.startsWith("/ialphabets/join/");

  useEffect(() => {
    setIalphabetsVaultOwnerToken(vaultOwnerToken ?? null);
  }, [vaultOwnerToken]);

  const shell = (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex-1">{children}</main>
      <VaultMethodPrompt enabled={!isJoinPreview} />
    </div>
  );

  if (isJoinPreview) {
    return shell;
  }

  return <VaultLockGuard>{shell}</VaultLockGuard>;
}
