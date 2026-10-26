"use client";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { HostedDocumentPanel } from "./hosted-document-panel";

export function HostedDocumentsPage() {
  const query = useSearchParams(); const requestId = query.get("ref") ?? "";
  const { user } = useAuth(); const { isVaultUnlocked } = useVault(); const [unlock, setUnlock] = useState(false);
  const valid = /^[0-9a-f-]{36}$/.test(requestId);
  return <AppPageShell width="reading">
    <AppPageHeaderRegion><PageHeader title="Protected documents" description="Your approved copy in One" /></AppPageHeaderRegion>
    <AppPageContentRegion>
      {!valid ? <HelperText>This protected document link is unavailable.</HelperText> : !user ? <>
        <HelperText>Sign in to the One account this document was shared with.</HelperText>
        <Button asChild><Link href={`/login?redirect=${encodeURIComponent(`/one/documents/open?ref=${requestId}`)}`}>Sign in</Link></Button>
      </> : !isVaultUnlocked ? <>
        <HelperText>Unlock your vault to decrypt this document on your device.</HelperText>
        <Button onClick={() => setUnlock(true)}>Unlock vault</Button>
        <VaultUnlockDialog user={user} open={unlock} onOpenChange={setUnlock} onSuccess={() => setUnlock(false)} title="Unlock protected documents" description="Decrypt approved copies on this device." />
      </> : <HostedDocumentPanel requestId={requestId} />}
    </AppPageContentRegion>
  </AppPageShell>;
}
