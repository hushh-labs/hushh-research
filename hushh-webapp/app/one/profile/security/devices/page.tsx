"use client";

import { useCallback, useEffect, useState } from "react";
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
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
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
}

export default function TrustedDevicesPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<TrustedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingRevocation, setPendingRevocation] =
    useState<TrustedDevice | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const response = await ApiService.listTrustedDevices();
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload?.detail?.message || "Devices unavailable.");
      setDevices(Array.isArray(payload.devices) ? payload.devices : []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Devices unavailable.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

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
      await load();
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
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
