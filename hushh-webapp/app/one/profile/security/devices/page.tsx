"use client";

import { useState } from "react";
import { Laptop, Loader2, Trash2 } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
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
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { deriveSyncDisplay } from "@/lib/trusted-device/sync-display";

interface TrustedDevice {
  device_id: string;
  device_name: string;
  platform: string;
  status: "active" | "revoked";
  created_at: number;
  last_used_at: number | null;
  // Added by migration 176; optional so an older payload still type-checks and
  // falls through to the honest "unavailable" / "not yet synced" states.
  revoked_at?: number | null;
  last_synced_at?: number | null;
  sealed_at?: number | null;
  // Added by migration 186; a fresh value is the only evidence the agent is
  // actually running, which last_synced_at can never establish.
  last_heartbeat_at?: number | null;
  heartbeat?: { current_model?: string; busy?: boolean } | null;
}

export default function TrustedDevicesPage() {
  const { user } = useAuth();
  const [error, setError] = useState("");
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
    load: async () => {
      const response = await ApiService.listTrustedDevices();
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail?.message || "Devices unavailable.");
      }
      return Array.isArray(payload.devices) ? payload.devices : [];
    },
  });

  const devices = devicesResource.data ?? [];
  // Only a cold load with nothing cached may block; a background refresh must
  // never hide list content that is already on screen.
  const loading = devicesResource.loading && devicesResource.data === null;
  const visibleError = error || devicesResource.error || "";

  async function revoke(deviceId: string) {
    if (!user) return;
    setRevoking(true);
    try {
      const response = await ApiService.revokeTrustedDevice(deviceId);
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

  return (
    <AppPageShell
      as="main"
      width="reading"
      nativeTest={{
        routeId: ROUTES.PROFILE_SECURITY_DEVICES,
        marker: "native-route-profile",
        authState: user ? "authenticated" : "pending",
        dataState: loading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Trusted devices"
          description="Computers connected as an extension of your private agent."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading devices…
          </div>
        ) : null}
        {visibleError ? (
          <p className="text-sm text-destructive">{visibleError}</p>
        ) : null}
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
                      <Button
                        aria-label={`Unlink ${device.device_name}`}
                        onClick={() => setPendingRevocation(device)}
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2 className="size-4" />
                      </Button>
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
    </AppPageShell>
  );
}
