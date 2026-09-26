"use client";

import { useEffect, useState } from "react";
import {
  LaptopIcon as Laptop,
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
} from "@/components/icons";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { ApiService } from "@/lib/services/api-service";
import { TrustedDevicesResourceService, type TrustedDevice } from "@/lib/services/trusted-devices-resource-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { deriveSyncDisplay } from "@/lib/trusted-device/sync-display";
import { useVault } from "@/lib/vault/vault-context";


/** Trusted devices is a recursive Profile-pane detail, not a standalone page. */
export default function TrustedDevicesPage() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [error, setError] = useState("");
  const [puppyAccess, setPuppyAccess] = useState<Record<string, boolean>>({});
  const [changingPuppy, setChangingPuppy] = useState<string | null>(null);
  const [puppyNotice, setPuppyNotice] = useState("");
  const [pendingPuppyWithdrawal, setPendingPuppyWithdrawal] = useState<string | null>(null);
  const [byocReady, setByocReady] = useState(false);
  const [pendingRevocation, setPendingRevocation] =
    useState<TrustedDevice | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Cache-first: a warm cache paints the list immediately and the refresh runs
  // in the background, so revisiting this screen never shows a blocking spinner
  // over data we already hold. Revoking force-refreshes through the same
  // resource so the cache can never serve a device the server just revoked.
  const devicesResource = useStaleResource<TrustedDevice[]>({
    cacheKey: CACHE_KEYS.TRUSTED_DEVICES(user?.uid || "anonymous"),
    enabled: Boolean(user),
    resourceLabel: "trusted-devices",
    load: () => TrustedDevicesResourceService.load(user!.uid),
  });

  const devices = devicesResource.data ?? [];
  const puppyDeviceIds = devices
    .filter((device) => device.platform === "macos" && device.status === "active")
    .map((device) => device.device_id)
    .join(",");
  useEffect(() => {
    if (!vaultOwnerToken) return;
    let cancelled = false;
    void ApiService.getPersonalAgentStatus().then((status) => {
      if (!cancelled) setByocReady(status.hostingMode === "byoc" && status.state === "active");
    }).catch(() => {
      if (!cancelled) setByocReady(false);
    });
    return () => { cancelled = true; };
  }, [vaultOwnerToken]);
  useEffect(() => {
    if (!vaultOwnerToken || !puppyDeviceIds) return;
    let cancelled = false;
    void Promise.all(
      puppyDeviceIds.split(",").map(async (deviceId) => [
        deviceId,
        await ApiService.getPuppyAccess(deviceId, vaultOwnerToken),
      ] as const),
    ).then((choices) => {
      if (!cancelled) setPuppyAccess(Object.fromEntries(choices));
    }).catch(() => {
      if (!cancelled) setError("Puppy access status is unavailable.");
    });
    return () => { cancelled = true; };
  }, [vaultOwnerToken, puppyDeviceIds]);

  async function changePuppyAccess(deviceId: string, enabled: boolean) {
    if (!vaultOwnerToken) {
      setError("Unlock your vault to change Puppy access.");
      return;
    }
    setChangingPuppy(deviceId);
    setError("");
    setPuppyNotice("");
    try {
      const result = await ApiService.setPuppyAccess(deviceId, enabled, vaultOwnerToken);
      setPuppyAccess((current) => ({ ...current, [deviceId]: result.enabled }));
      if (result.revocationPending) {
        setPendingPuppyWithdrawal(deviceId);
        setPuppyNotice("New Puppy access is disabled. Pod revocation is pending or unverified; retry withdrawal after the pod reconnects.");
      } else if (pendingPuppyWithdrawal === deviceId) {
        setPendingPuppyWithdrawal(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Puppy access could not be changed.");
    } finally {
      setChangingPuppy(null);
    }
  }
  // Only a cold load with nothing cached may block; a background refresh must
  // never hide list content that is already on screen.
  const loading = devicesResource.loading && devicesResource.data === null;
  const visibleError = error || devicesResource.error || "";

  async function revoke(deviceId: string) {
    if (!user) return;
    setRevoking(true);
    try {
      const response = await TrustedDevicesResourceService.revoke(user.uid, deviceId);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(
          payload?.detail?.message || "The device could not be revoked.",
        );
        return;
      }
      setPendingRevocation(null);
      setError("");
      await devicesResource.refresh({ force: true });
    } finally {
      setRevoking(false);
    }
  }

  const nowMs = Date.now();

  const pageContent = (
    <>
      <AppPageHeaderRegion>
        <PageHeader
          title="Trusted devices"
          // The pane's top bar already names this screen; one title per screen.
          titleVisuallyHidden
          description="Computers connected as an extension of your private agent."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SettingsPresentationProvider density="compact">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading devices…
            </div>
          ) : null}
          {visibleError ? (
            <p className="text-sm text-destructive">{visibleError}</p>
          ) : null}
          {puppyNotice ? <p className="text-sm text-muted-foreground">{puppyNotice}</p> : null}
          {devices.length > 0 ? (
            <SettingsGroup separatorInset>
              {devices.map((device) => {
                const sync = deriveSyncDisplay(device, nowMs);
                const isActive = device.status === "active";
                return (
                  <SettingsRow
                    key={device.device_id}
                    icon={Laptop}
                    title={device.device_name}
                    description={sync.label}
                    trailing={
                      isActive ? (
                        <div className="flex items-center gap-2">
                          {byocReady && device.platform === "macos" && puppyAccess[device.device_id] !== undefined ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={changingPuppy === device.device_id}
                              onClick={() => void changePuppyAccess(device.device_id, pendingPuppyWithdrawal === device.device_id ? false : !puppyAccess[device.device_id])}
                            >
                              {changingPuppy === device.device_id ? "Updating…" : pendingPuppyWithdrawal === device.device_id ? "Retry withdrawal" : puppyAccess[device.device_id] ? "Disable Puppy" : "Enable Puppy"}
                            </Button>
                          ) : null}
                          <Button
                            aria-label={`Unlink ${device.device_name}`}
                            onClick={() => setPendingRevocation(device)}
                            size="icon"
                            variant="ghost"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ) : undefined
                    }
                    trailingInteractive={isActive}
                  />
                );
              })}
            </SettingsGroup>
          ) : null}
          {!loading && devices.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              No trusted devices are connected.
            </p>
          ) : null}
        </SettingsPresentationProvider>
      </AppPageContentRegion>
      <AlertDialog
        open={pendingRevocation !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setPendingRevocation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unlink {pendingRevocation?.device_name || "this device"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This device will stop syncing immediately, and its local copy of
              your vault will be sealed on the device. Reconnecting requires
              approving it again in your browser and setting up the local vault
              from scratch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking || pendingRevocation === null}
              onClick={(event) => {
                event.preventDefault();
                if (pendingRevocation) void revoke(pendingRevocation.device_id);
              }}
            >
              {revoking ? "Unlinking…" : "Unlink device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return <div className="w-full">{pageContent}</div>;
}
