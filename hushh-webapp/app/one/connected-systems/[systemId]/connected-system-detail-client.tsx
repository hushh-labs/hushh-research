"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Building2 } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { SectionHeader } from "@/components/app-ui/page-sections";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import type { ConnectedSystemAgentInstruction } from "@/components/profile/connected-systems-panel";

export function ConnectedSystemDetailClient({ systemId }: { systemId: string }) {
  const { user, phoneNumber } = useAuth();
  const { vaultOwnerToken } = useVault();
  const searchParams = useSearchParams();
  const [showUnlock, setShowUnlock] = useState(false);
  const [agentInstruction] = useState<ConnectedSystemAgentInstruction | null>(() => {
    if (typeof window === "undefined") return null;
    const instructionId = searchParams.get("agentActionId");
    if (!instructionId) return null;
    const key = `hushh:connected-system-agent-action:${instructionId}`;
    const raw = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as ConnectedSystemAgentInstruction;
      return typeof record.actionId === "string" ? record : null;
    } catch {
      return null;
    }
  });

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-[calc(var(--app-bottom-inset)+var(--kai-command-fixed-ui,82px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/connected-systems/[systemId]",
        marker: "native-route-connected-system-detail",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <NativeTestBeacon
        routeId="/one/connected-systems/[systemId]"
        marker="native-route-connected-system-detail"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <AppPageHeaderRegion>
        <SectionHeader
          title="Connected system"
          icon={Building2}
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <ConnectedSystemsPanel
          vaultOwnerToken={vaultOwnerToken}
          onRequestUnlock={() => setShowUnlock(true)}
          mode="detail"
          systemId={systemId}
          agentInstruction={agentInstruction}
          profile={{
            displayName: user?.displayName,
            email: user?.email,
            phone: phoneNumber,
          }}
        />
      </AppPageContentRegion>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlock}
          onOpenChange={setShowUnlock}
          title="Unlock vault"
          description="Unlock your vault to inspect CRM records and approve Connected Systems actions."
          onSuccess={() => setShowUnlock(false)}
        />
      ) : null}
    </AppPageShell>
  );
}
