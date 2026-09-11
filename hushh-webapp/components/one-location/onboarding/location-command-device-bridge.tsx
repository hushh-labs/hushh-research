"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { OneLocationService } from "@/lib/one-location/service";
import { OneLocationPreVaultDraftService } from "@/lib/services/one-location-pre-vault-draft-service";
import {
  type LocationOnboardingRunResultV1,
} from "@/lib/services/one-location-onboarding-run-client";
import {
  OneLocationOnboardingDeviceOrchestrator,
  type LocationPermissionSettlement,
  type OneLocationDeviceInteractionPort,
  type OneLocationInteractionSurfacePort,
} from "@/lib/services/one-location-onboarding-device-orchestrator";
import {
  locationPermissionPreflight,
  parseFreshLocationRuntimeCapture,
} from "@/lib/services/one-location-device-evidence";
import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";

import {
  useOptionalOneLocationInteractionSurface,
  type LocationInteractionSurfaceContextValue,
} from "./location-onboarding-interaction-surface";

function activeSurface(
  ref: React.MutableRefObject<LocationInteractionSurfaceContextValue | null>,
): LocationInteractionSurfaceContextValue {
  const surface = ref.current;
  if (!surface) {
    throw new Error("Location command surface is unavailable.");
  }
  return surface;
}

/**
 * The command-only owner for server-issued Location cards.
 *
 * This intentionally lives above route chrome. It can settle real OS
 * permission and fresh GPS observations from any screen, while a place save
 * still hands off to the existing Location screen until that screen's PKM
 * receipt is explicitly bound to the v2 runtime. That boundary prevents the
 * legacy setup coordinator from claiming a command run completed.
 */
export function LocationCommandDeviceBridge() {
  const surface = useOptionalOneLocationInteractionSurface();
  const { userId } = useAuth();
  const router = useRouter();
  const surfaceRef = useRef<LocationInteractionSurfaceContextValue | null>(
    surface,
  );
  const userIdRef = useRef<string | null>(userId ?? null);
  const observedPermissionDenialRef = useRef(false);
  const processedDirectiveRef = useRef<string | null>(null);

  useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);

  useEffect(() => {
    userIdRef.current = userId ?? null;
  }, [userId]);

  const openLocationSetup = useCallback((): boolean => {
    const requested = requestInternalAppNavigation({
      href: "/one/setup/location",
      source: "voice",
      transitionMode: "contextual",
      scroll: false,
    });
    if (!requested) router.push("/one/setup/location", { scroll: false });
    return true;
  }, [router]);

  const openLocation = useCallback((): void => {
    const requested = requestInternalAppNavigation({
      href: "/one/location",
      source: "voice",
      transitionMode: "contextual",
      scroll: false,
    });
    if (!requested) router.push("/one/location", { scroll: false });
  }, [router]);

  const surfacePort = useMemo<OneLocationInteractionSurfacePort>(
    () => ({
      get currentRun() {
        return surfaceRef.current?.currentRun ?? null;
      },
      startOrResume: (contextRevision) =>
        activeSurface(surfaceRef).startOrResume(contextRevision),
      settle: (input) => activeSurface(surfaceRef).settle(input),
      presentServerResult: (result, options) =>
        activeSurface(surfaceRef).presentServerResult(result, options),
      publishLocal: (state, options) =>
        activeSurface(surfaceRef).publishLocal(state, options),
      dismiss: () => activeSurface(surfaceRef).dismiss(),
    }),
    [],
  );

  const devicePort = useMemo<OneLocationDeviceInteractionPort>(
    () => ({
      requestPermission: async (): Promise<LocationPermissionSettlement> => {
        let permission;
        try {
          permission = await OneLocationService.requestLocationPermission();
        } catch {
          permission = await OneLocationService.getPermissionState().catch(
            () => null,
          );
        }
        if (!permission) return "permission_restricted";
        if (permission.state === "denied") {
          observedPermissionDenialRef.current = true;
        }
        return (
          locationPermissionPreflight(
            permission,
            observedPermissionDenialRef.current,
          ) ??
          (permission.locationServicesEnabled === false
            ? "services_disabled"
            : permission.state === "denied"
              ? "permission_denied"
              : "permission_restricted")
        );
      },
      capturePosition: () =>
        OneLocationService.captureCurrentPosition({ fresh: true }),
      retainPosition: async (capture) =>
        parseFreshLocationRuntimeCapture(capture) !== null,
      // A Location command may not write a place through the legacy page's
      // unbound client save. `present()` routes this to the actual form and
      // retains the server run; a later v2 PKM receipt/finalizer will replace
      // this safe navigation fallback.
      savePlace: async () => false,
      openPlaceForm: async () => openLocationSetup(),
      openSettings: async () => {
        const permission = await OneLocationService.getPermissionState().catch(
          () => null,
        );
        if (permission?.locationServicesEnabled === false) {
          await OneLocationService.openLocationSettings();
          return;
        }
        await OneLocationService.openAppSettings();
      },
      discardPreparedDraft: async (runId) => {
        const ownerId = userIdRef.current;
        if (!ownerId) return;
        const binding =
          await OneLocationPreVaultDraftService.readRecoveryBindingForRun(
            ownerId,
            runId,
          ).catch(() => null);
        if (!binding) return;
        await OneLocationPreVaultDraftService.clearExact(
          ownerId,
          binding.runId,
          binding.revision,
          binding.digest,
        );
      },
      showReady: () => {
        const current = surfaceRef.current;
        const run = current?.currentRun;
        if (
          !current ||
          !run ||
          run.status !== "verified_succeeded" ||
          !run.completionClaimAllowed
        ) {
          return;
        }
        // This local card is reachable only after a server-issued verified
        // settlement; a pre-vault draft is never a completion claim.
        current.publishLocal("verified_complete", {
          run,
          dismissible: true,
        });
      },
      openLocation,
    }),
    [openLocation, openLocationSetup],
  );

  const orchestrator = useMemo(
    () => new OneLocationOnboardingDeviceOrchestrator(surfacePort, devicePort),
    [devicePort, surfacePort],
  );

  useEffect(() => {
    if (!getVoiceV2Flags().locationCommandRuntimeEnabled) {
      processedDirectiveRef.current = null;
      orchestrator.cancel();
      return;
    }
    const activeDirective = surface?.directive;
    if (!activeDirective || activeDirective.authority !== "server") return;
    const directive = activeDirective.serverDirective;
    const run = activeDirective.run;
    const key = `${run.runId}:${run.revision}:${directive.directiveId}`;
    if (processedDirectiveRef.current === key) return;
    processedDirectiveRef.current = key;
    const result: LocationOnboardingRunResultV1 = {
      schemaVersion: "one.location_onboarding_run_result.v1",
      run,
      directive,
      waitingReason: null,
    };
    orchestrator.present(result);
  }, [orchestrator, surface?.directive]);

  useEffect(
    () => () => {
      orchestrator.cancel();
    },
    [orchestrator],
  );

  return null;
}
