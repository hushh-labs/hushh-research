"use client";

import { Capacitor } from "@capacitor/core";
import { Button } from "@/components/ui/button";
import { resolveLocationRecoveryGuide } from "@/lib/one-location/location-permission-recovery";
import {
  isLocationPermissionDeniedError,
  LOCATION_BLOCK_MESSAGE,
  locationBlockReason,
  type LocationBlockReason,
} from "@/lib/one-location/location-readiness";
import { OneLocationService } from "@/lib/one-location/service";

class ChatLocationBlocked extends Error {
  constructor(readonly reason: LocationBlockReason) {
    super(LOCATION_BLOCK_MESSAGE[reason]);
  }
}

export function chatLocationPermissionIssue(error: unknown) {
  if (error instanceof ChatLocationBlocked) return error.reason;
  return isLocationPermissionDeniedError(error) ? "denied" as const : null;
}
export type ChatLocationPermissionIssue = ReturnType<typeof chatLocationPermissionIssue>;

export async function captureChatLocation() {
  const permission = await OneLocationService.getPermissionState().catch(() => null);
  const blocked = locationBlockReason(permission);
  if (blocked) throw new ChatLocationBlocked(blocked);
  if (permission?.state === "denied") OneLocationService.invalidateCapturedPosition();
  // The bus prompts if the host allows it and only accepts a measured fix.
  const point = await OneLocationService.captureCurrentPosition({ fresh: true, requireMeasurement: true });
  return { point, reducedAccuracy: permission?.precise === false };
}

export function LocationChatPermissionRecovery({ issue }: { issue: ChatLocationPermissionIssue }) {
  if (!issue || issue === "restricted" || issue === "unsupported") return null;
  const guide = resolveLocationRecoveryGuide({
    userAgent: navigator.userAgent,
    isNativeApp: Capacitor.isNativePlatform(),
    nativePlatform: Capacitor.getPlatform(),
  });
  const servicesOff = issue === "services-off";
  const steps = servicesOff ? ["Turn on Location Services for your device."] :
    guide.steps.filter((step) => !step.startsWith("Come back here") && !step.startsWith("Reload this page"));
  return <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-sm">
    <p className="font-medium">{servicesOff ? "Location Services are off" : guide.title}</p>
    <ol className="list-decimal space-y-1 pl-5">
      {steps.map((step) => <li key={step}>{step}</li>)}
      <li>Return to this chat and try again.</li>
    </ol>
    {guide.canOpenSettings ? <Button type="button" variant="outline" onClick={(event) => {
      if (!event.nativeEvent.isTrusted) return;
      const openSettings = servicesOff ? OneLocationService.openLocationSettings : OneLocationService.openAppSettings;
      void openSettings().catch(() => undefined);
    }}>Open device settings</Button> : null}
  </div>;
}
