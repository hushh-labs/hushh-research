"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { VaultService } from "@/lib/services/vault-service";
import { useVault } from "@/lib/vault/vault-context";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import {
  preferPassphraseUnlockForAutomation,
  useNativeTestConfig,
} from "@/lib/testing/native-test";

import { VaultUnlockDialog } from "./vault-unlock-dialog";

type VaultPrerequisiteState =
  | "checking"
  | "ready"
  | "create_required"
  | "unlock_required"
  | "failed";

type CapabilityVaultPrerequisiteProps = {
  capabilityLabel: string;
  routeKey: string;
  children: ReactNode;
  /**
   * Safe, non-interactive route chrome that may render while the vault owner
   * token is being checked. It must not read protected route data.
   */
  checkingFallback?: ReactNode;
  allowVaultCreation?: boolean;
};

/**
 * A capability boundary for the first operation that needs encrypted owner
 * information. It works on setup and normal product routes, so choosing a
 * capability later receives the same contextual vault introduction.
 *
 * This does not alter VaultLockGuard. That guard remains responsible for
 * already-protected pages; this boundary prevents a token-dependent capability
 * from mounting before its vault can be created or opened.
 */
export function CapabilityVaultPrerequisite({
  capabilityLabel,
  routeKey,
  children,
  checkingFallback,
  allowVaultCreation = true,
}: CapabilityVaultPrerequisiteProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const nativeTestConfig = useNativeTestConfig();
  const userId = user?.uid ?? null;
  const { vaultOwnerToken } = useVault();
  const [state, setState] = useState<VaultPrerequisiteState>("checking");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [vaultHandoffPending, setVaultHandoffPending] = useState(false);
  const autoPresentedRef = useRef(false);
  const vaultBoundaryActive =
    state === "create_required" || state === "unlock_required" || vaultHandoffPending;

  useEffect(() => {
    if (authLoading || userId) return;
    router.replace(`/login?redirect=${encodeURIComponent(routeKey)}`);
  }, [authLoading, routeKey, router, userId]);

  useEffect(() => {
    if (authLoading) {
      setVaultHandoffPending(false);
      setState("checking");
      return;
    }
    if (!userId) {
      setVaultHandoffPending(false);
      setState("failed");
      return;
    }
    if (vaultOwnerToken) {
      setVaultHandoffPending(false);
      setState("ready");
      return;
    }
    // VaultFlow has already issued the owner token and asked the shared vault
    // context to publish it. Keep this capability inert until that memory-only
    // authority arrives; a second presence check would mistake the new vault
    // for a locked vault and strand the setup route behind stale UI.
    if (vaultHandoffPending) {
      return;
    }

    let active = true;
    setState("checking");
    void VaultService.checkVault(userId)
      .then((hasVault) => {
        if (!active) return;
        setState(hasVault ? "unlock_required" : "create_required");
      })
      .catch((error) => {
        console.warn("[CapabilityVaultPrerequisite] Failed to check vault state:", error);
        if (active) setState("failed");
      });
    return () => {
      active = false;
    };
  }, [authLoading, retryKey, userId, vaultHandoffPending, vaultOwnerToken]);

  useEffect(() => {
    if (
      (state !== "create_required" && state !== "unlock_required") ||
      autoPresentedRef.current
    ) {
      return;
    }
    autoPresentedRef.current = true;
    setDialogOpen(true);
  }, [state]);

  usePublishVoiceSurfaceMetadata(
    vaultBoundaryActive
      ? {
          screenId: "capability_vault_prerequisite",
          title: `Set up vault for ${capabilityLabel}`,
          purpose:
            "A private-vault credential sheet is active. It must settle before this capability can use encrypted information.",
          interactionLayer: {
            schemaVersion: "voice_interaction_layer.v1",
            id: `capability_vault_${routeKey.replaceAll("/", "_")}`,
            kind: "vault_setup",
            modality: "blocking",
            lifecycle: "open",
            dismissible: false,
            visibleActionIds: [],
            visibleControlIds: [],
            options: [],
            blocksUnderlyingActions: true,
            agentContinuity: "suppressed",
          },
        }
      : null,
    { role: "interaction_layer", routeKey },
  );

  // A token is memory-only and is the actual authority for the capability.
  // Render immediately once it arrives instead of briefly flashing a loader
  // while the status effect catches up after vault settlement.
  if (vaultOwnerToken || state === "ready") return <>{children}</>;
  if (!userId) {
    return <RouteLoadingState label="Redirecting to sign in…" />;
  }
  if (state === "checking") {
    return checkingFallback ?? <RouteLoadingState label={`Preparing ${capabilityLabel}…`} />;
  }
  if (vaultHandoffPending) {
    return <RouteLoadingState label={`Opening ${capabilityLabel}…`} />;
  }

  const failed = state === "failed";
  const actionLabel =
    state === "unlock_required"
      ? "Open your private vault"
      : "Set up your private vault";

  if (failed) {
    return (
      <section className="mx-auto flex min-h-[18rem] w-full max-w-[32rem] flex-col items-center justify-center gap-3 px-4 text-center sm:px-6">
        <p className="text-sm leading-6 text-muted-foreground">
          We could not confirm your vault yet.
        </p>
        <Button
          type="button"
          variant="blue"
          effect="fill"
          onClick={() => {
            autoPresentedRef.current = false;
            setRetryKey((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </section>
    );
  }

  return (
    <section className="min-h-[18rem] w-full" aria-busy="true">
      <RouteLoadingState label={`Preparing ${capabilityLabel}…`} />
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={actionLabel}
          description={`Continue ${capabilityLabel} setup after your private vault is ready.`}
          enableGeneratedDefault={
            !preferPassphraseUnlockForAutomation(nativeTestConfig)
          }
          allowVaultCreation={allowVaultCreation}
          onSuccess={() => {
            setVaultHandoffPending(true);
            setDialogOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}
