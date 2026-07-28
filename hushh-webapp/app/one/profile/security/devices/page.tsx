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
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";

interface TrustedDevice {
  device_id: string;
  device_name: string;
  platform: string;
  status: "active" | "revoked";
  created_at: number;
  last_used_at: number | null;
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
          {devices.map((device) => (
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
                <p className="mt-1 text-xs text-muted-foreground">
                  {device.status === "active" ? "Active" : "Revoked"} ·{" "}
                  {device.platform}
                </p>
              </div>
              {device.status === "active" ? (
                <Button
                  aria-label={`Revoke ${device.device_name}`}
                  onClick={() => setPendingRevocation(device)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </article>
          ))}
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
            <AlertDialogTitle>Revoke this trusted device?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevocation?.device_name || "This device"} will immediately
              lose access to new owner capabilities and Personal Data writes.
              Reconnecting requires browser approval and local vault setup
              again.
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
              {revoking ? "Revoking…" : "Revoke device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}
