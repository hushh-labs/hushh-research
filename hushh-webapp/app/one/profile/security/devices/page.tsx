"use client";

import { useCallback, useEffect, useState } from "react";
import { Laptop, Loader2, Trash2 } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
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
import { formatRelativeTime } from "@/lib/format/relative-time";
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import {
  deriveSyncDisplay,
  type SyncTone,
} from "@/lib/trusted-device/sync-display";

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

const _SYNC_TONE_CLASS: Record<SyncTone, string> = {
  active: "text-foreground",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
};

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
        <div className="space-y-3">
          {devices.map((device) => {
            const sync = deriveSyncDisplay(device, nowMs);
            const connected = formatRelativeTime(device.created_at, nowMs);
            const lastActive = formatRelativeTime(device.last_used_at, nowMs);
            const meta = [
              device.platform,
              connected ? `Connected ${connected}` : "",
              lastActive ? `Last active ${lastActive}` : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <article
                className="flex items-center gap-4 rounded-2xl border bg-card p-4"
                key={device.device_id}
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
                  <Laptop className="size-5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-medium">
                    {device.device_name}
                  </h2>
                  <p
                    className={`mt-1 truncate text-xs font-medium ${_SYNC_TONE_CLASS[sync.tone]}`}
                  >
                    {sync.label}
                  </p>
                  {meta ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {meta}
                    </p>
                  ) : null}
                </div>
                {device.status === "active" ? (
                  <Button
                    aria-label={`Unlink ${device.device_name}`}
                    onClick={() => setPendingRevocation(device)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </article>
            );
          })}
          {!loading && devices.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              No trusted devices are connected.
            </p>
          ) : null}
        </div>
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
