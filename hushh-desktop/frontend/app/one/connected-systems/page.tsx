"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";

export default function ConnectedSystemsPage() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [showUnlock, setShowUnlock] = useState(false);

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/connected-systems",
        marker: "native-route-connected-systems",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <NativeTestBeacon
        routeId="/one/connected-systems"
        marker="native-route-connected-systems"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One / Connected Systems"
          title="CRM systems"
          description="Browse connected customer systems, inspect their status, and open a CRM workspace when a record needs review."
          icon={Building2}
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <ConnectedSystemsPanel
          vaultOwnerToken={vaultOwnerToken}
          onRequestUnlock={() => setShowUnlock(true)}
          mode="list"
        />
      </AppPageContentRegion>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlock}
          onOpenChange={setShowUnlock}
          title="Unlock vault"
          description="Unlock your vault to inspect Salesforce CRM and approve Connected Systems actions."
          onSuccess={() => setShowUnlock(false)}
        />
      ) : null}
    </AppPageShell>
  );
}
