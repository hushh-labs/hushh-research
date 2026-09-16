"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useLocationCommand } from "@/components/agent/location-command-provider";
import { saveRequestedLocationWorkflowPlace } from "@/lib/one-location/saved-locations";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { OneLocationService } from "@/lib/one-location/service";
import { OneLocationPreVaultDraftService } from "@/lib/services/one-location-pre-vault-draft-service";
import {
  OneLocationOnboardingRunClient,
  type LocationOnboardingRunResultV1,
} from "@/lib/services/one-location-onboarding-run-client";
import {
  OneLocationOnboardingDeviceOrchestrator,
  LocationSaveOutcomeUnknown,
  type LocationPermissionSettlement,
  type OneLocationDeviceInteractionPort,
  type OneLocationInteractionSurfacePort,
} from "@/lib/services/one-location-onboarding-device-orchestrator";
import {
  locationPermissionPreflight,
  parseFreshLocationRuntimeCapture,
} from "@/lib/services/one-location-device-evidence";

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
 * permission and fresh GPS observations from any screen, then save the
 * requested private default through the existing PKM writer. Only the
 * workflow's verified receipt chain can complete its command step.
 */
export function LocationCommandDeviceBridge() {
  const surface = useOptionalOneLocationInteractionSurface();
  const { userId } = useAuth();
  const vault = useVault();
  const command = useLocationCommand();
  const commandGeneration = command.command.activeGeneration();
  const commandRef = useRef(command);
  commandRef.current = command;
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const router = useRouter();
  const surfaceRef = useRef<LocationInteractionSurfaceContextValue | null>(
    surface,
  );
  const userIdRef = useRef<string | null>(userId ?? null);
  const observedPermissionDenialRef = useRef(false);
  const processedDirectiveRef = useRef<string | null>(null);
  const retainedPositionRef = useRef<{ owner: string; runId: string; capture: NonNullable<ReturnType<typeof parseFreshLocationRuntimeCapture>> } | null>(null);
  userIdRef.current = userId ?? null;

  const requireActive = useCallback((runId: string, generation?: number) => {
    const owner = userIdRef.current;
    const value = vaultRef.current;
    if (!owner || !value.isVaultUnlocked || !value.vaultKey || !value.vaultOwnerToken
      || commandRef.current.workflowResult?.run.runId !== runId
      || !commandRef.current.command.isWorkflowActive(runId, generation)) throw new Error("Unlock and resume this Location task before continuing.");
    return { userId: owner, vaultKey: value.vaultKey, vaultOwnerToken: value.vaultOwnerToken };
  }, []);

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

  const surfacePort = useMemo<OneLocationInteractionSurfacePort>(() => {
    const generation = commandGeneration;
    const active = (runId?: string) => requireActive(runId || "", generation);
    return {
      get currentRun() { return surfaceRef.current?.currentRun ?? null; },
      startOrResume: async () => {
        const runId = command.workflowResult?.run.runId;
        const owner = active(runId);
        return OneLocationOnboardingRunClient.get(runId!, { expectedUserId: owner.userId });
      },
      settle: async (input) => {
        active(input.run?.runId);
        const result = await activeSurface(surfaceRef).settle(input);
        active(input.run?.runId);
        return result;
      },
      presentServerResult: (result, options) => {
        active(result.run.runId);
        activeSurface(surfaceRef).presentServerResult(result, options);
      },
      publishLocal: (state, options) => {
        active(options?.run?.runId);
        activeSurface(surfaceRef).publishLocal(state, options);
      },
      dismiss: () => {
        active(command.workflowResult?.run.runId);
        activeSurface(surfaceRef).dismiss();
      },
    };
  }, [commandGeneration, command.workflowResult, requireActive]);

  const devicePort = useMemo<OneLocationDeviceInteractionPort>(
    () => {
      const generation = commandGeneration;
      const active = (runId: string) => requireActive(runId, generation);
      return ({
      requestedPrivateSetup: () => Boolean(commandRef.current.workflowResult && vaultRef.current.isVaultUnlocked),
      resumeRequestedWorkflow: () => commandRef.current.command.refresh(),
      reviewRequestedSave: (runId) => {
        active(runId);
        commandRef.current.command.reviewWorkflowSave(runId);
      },
      observePermission: async (run) => {
        active(run.runId);
        const permission = await OneLocationService.getPermissionState();
        return locationPermissionPreflight(permission, observedPermissionDenialRef.current);
      },
      requestPermission: async (run): Promise<LocationPermissionSettlement> => {
        active(run.runId);
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
      capturePosition: (run) => {
        active(run.runId);
        return OneLocationService.captureCurrentPosition({ fresh: true });
      },
      retainPosition: async (capture, run) => {
        const point = parseFreshLocationRuntimeCapture(capture);
        const runId = run.runId;
        if (!point || !runId) return false;
        const owner = active(runId).userId;
        retainedPositionRef.current = { owner, runId, capture: point };
        // Persist capture before consuming its position lease. Termination
        // between position and place preparation can then recover the same fix.
        await commandRef.current.command.clearWorkflowDraft(runId);
        active(runId);
        await commandRef.current.command.stageWorkflowDraft(runId, run.revision, {
          category: "other", label: "Current location", address: null,
          latitude: point.latitude, longitude: point.longitude, accuracyM: point.accuracyM ?? null,
          capturedAt: point.capturedAt, sourcePlatform: point.sourcePlatform,
        });
        active(runId);
        return true;
      },
      savePlace: async ({ run }) => {
        const authority = active(run.runId);
        const runtime = commandRef.current.command;
        let staged = await runtime.readWorkflowDraft(run.runId);
        active(run.runId);
        if (run.pendingDirective?.contractId === "one.location.place_persisting.v2") {
          const retained = retainedPositionRef.current;
          const point = retained?.owner === authority.userId && retained.runId === run.runId
            ? parseFreshLocationRuntimeCapture(retained.capture) : null;
          if (!staged && !point) throw new Error("A fresh position is needed. Resume Location setup.");
          const metadata = await runtime.stageWorkflowDraft(run.runId, run.revision, staged?.draft || {
            category: "other", label: "Current location", address: null,
            latitude: point!.latitude, longitude: point!.longitude,
            accuracyM: point!.accuracyM ?? null, capturedAt: point!.capturedAt, sourcePlatform: point!.sourcePlatform,
          });
          active(run.runId);
          return activeSurface(surfaceRef).settle({ run, result: "draft_prepared", draftMetadata: metadata });
        }
        const finalize = run.pkmFinalizeAuthorization;
        if (!staged || !finalize || finalize.runId !== run.runId || finalize.draftDigest !== staged.metadata.digest) {
          throw new Error("The private draft or save authority is unavailable. Resume this task.");
        }
        if (staged.commitDispatched) {
          // An uncertain write is reconciled, never speculatively sent again.
          const result = await OneLocationOnboardingRunClient.get(run.runId, { expectedUserId: authority.userId });
          active(run.runId);
          if (!result.run.evidence.place) throw new LocationSaveOutcomeUnknown();
          return result;
        }
        const saved = await saveRequestedLocationWorkflowPlace({
          context: authority, draft: staged.draft, finalize,
          beforeEffect: async () => {
            active(run.runId);
            const permission = await OneLocationService.getPermissionState();
            active(run.runId);
            if (permission.state !== "granted" || permission.locationServicesEnabled === false) throw new Error("Location permission changed. Resume setup to check access.");
            await runtime.markWorkflowCommitDispatched(run.runId);
            active(run.runId);
          },
          authorization: { authorizationMode: "owner_requested_workflow", source: "location_onboarding_command", surface: "voice", workflowAuthority: staged.authority },
        }).catch(async (error: unknown) => {
          active(run.runId);
          const current = await runtime.readWorkflowDraft(run.runId);
          if (current?.commitDispatched) throw new LocationSaveOutcomeUnknown();
          throw error;
        });
        active(run.runId);
        if (saved.conflict) {
          await runtime.markWorkflowCommitDispatched(run.runId, false);
          throw new Error("Your saved places changed. Resume to retry with the current information.");
        }
        const result = await OneLocationOnboardingRunClient.get(run.runId, { expectedUserId: authority.userId });
        active(run.runId);
        if (!result.run.evidence.place) throw new LocationSaveOutcomeUnknown();
        await runtime.clearWorkflowDraft(run.runId);
        active(run.runId);
        return result;
      },
      openPlaceForm: async () => openLocationSetup(),
      openSettings: async (run) => {
        active(run?.runId || "");
        const permission = await OneLocationService.getPermissionState().catch(
          () => null,
        );
        active(run?.runId || "");
        if (permission?.locationServicesEnabled === false) {
          await OneLocationService.openLocationSettings();
          return;
        }
        await OneLocationService.openAppSettings();
      },
      discardPreparedDraft: async (runId) => {
        if (commandRef.current.workflowResult?.run.runId === runId) {
          await commandRef.current.command.clearWorkflowDraft(runId);
          retainedPositionRef.current = null;
          return;
        }
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
      showReady: (verifiedRun) => {
        const current = surfaceRef.current;
        const run = verifiedRun || current?.currentRun;
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
        retainedPositionRef.current = null;
        commandRef.current.run(commandRef.current.command.refresh());
      },
      openLocation,
    });
    },
    [commandGeneration, openLocation, openLocationSetup, requireActive],
  );

  const orchestrator = useMemo(
    () => new OneLocationOnboardingDeviceOrchestrator(surfacePort, devicePort),
    [devicePort, surfacePort],
  );

  useEffect(() => {
    const requested = command.workflowResult;
    if (!requested || !vault.isVaultUnlocked
      || !command.command.isWorkflowActive(requested.run.runId, commandGeneration)) {
      orchestrator.cancel();
      retainedPositionRef.current = null;
      processedDirectiveRef.current = null;
      return;
    }
    const key = `${commandGeneration}:${requested.run.runId}:${requested.run.revision}:${requested.directive?.directiveId || requested.run.status}`;
    if (processedDirectiveRef.current === key) return;
    processedDirectiveRef.current = key;
    orchestrator.present(requested);
  }, [command.command, command.workflowResult, commandGeneration, orchestrator, vault.isVaultUnlocked]);

  useEffect(() => {
    const activeDirective = surface?.directive;
    if (!activeDirective || activeDirective.authority !== "server" || !vault.isVaultUnlocked
      || activeDirective.run.runId !== command.workflowResult?.run.runId
      || activeDirective.run.revision < command.workflowResult.run.revision
      || !command.command.isWorkflowActive(activeDirective.run.runId, commandGeneration)) return;
    const directive = activeDirective.serverDirective;
    const run = activeDirective.run;
    const key = `${commandGeneration}:${run.runId}:${run.revision}:${directive.directiveId}`;
    if (processedDirectiveRef.current === key) return;
    processedDirectiveRef.current = key;
    const result: LocationOnboardingRunResultV1 = {
      schemaVersion: "one.location_onboarding_run_result.v1",
      run,
      directive,
      waitingReason: null,
    };
    orchestrator.present(result);
  }, [command.command, command.workflowResult, commandGeneration, orchestrator, surface?.directive, vault.isVaultUnlocked]);

  useEffect(
    () => () => {
      orchestrator.cancel();
    },
    [orchestrator],
  );

  return null;
}
