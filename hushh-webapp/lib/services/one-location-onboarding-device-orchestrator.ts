"use client";

import {
  OneLocationOnboardingRunClient,
  type BoundedLocationInteractionResult,
  type LocationInteractionState,
  type LocationOnboardingRunResultV1,
  type LocationPositionObservationV1,
  type LocationPreVaultDraftMetadataV1,
  type LocationRunProjectionV1,
} from "@/lib/services/one-location-onboarding-run-client";
import { parseFreshLocationRuntimeCapture } from "@/lib/services/one-location-device-evidence";
import {
  markLocationPermissionResultObserved,
  recordLocationPermissionRequestStarted,
  recordLocationPositionCaptureStarted,
} from "@/lib/one-location/one-location-runtime-telemetry";

export type LocationPermissionSettlement =
  | "permission_granted"
  | "permission_denied"
  | "permission_restricted"
  | "services_disabled";

/** The writer cannot establish whether its effect committed; never retry it here. */
export class LocationSaveOutcomeUnknown extends Error {}

type SurfaceAction = () => unknown | Promise<unknown>;

export type OneLocationInteractionSurfacePort = {
  currentRun: LocationRunProjectionV1 | null;
  startOrResume: (
    contextRevision?: string | null,
  ) => Promise<LocationOnboardingRunResultV1>;
  settle: (input: {
    run?: LocationRunProjectionV1;
    result: string;
    draftMetadata?: LocationPreVaultDraftMetadataV1 | null;
    positionObservation?: LocationPositionObservationV1 | null;
  }) => Promise<LocationOnboardingRunResultV1>;
  presentServerResult: (
    result: LocationOnboardingRunResultV1,
    options?: {
      dismissible?: boolean;
      onResult?: Readonly<Record<string, SurfaceAction>>;
    },
  ) => void;
  publishLocal: (
    state: LocationInteractionState,
    options?: {
      run?: LocationRunProjectionV1 | null;
      dismissible?: boolean;
      onPrimary?: SurfaceAction;
      onSecondary?: SurfaceAction;
    },
  ) => void;
  dismiss: () => void;
};

export type OneLocationDeviceInteractionPort = {
  requestedPrivateSetup?: () => boolean;
  observePermission?: (run: LocationRunProjectionV1) => Promise<LocationPermissionSettlement | null>;
  resumeRequestedWorkflow?: () => Promise<void>;
  reviewRequestedSave?: (runId: string) => void;
  requestPermission: (run: LocationRunProjectionV1) => Promise<LocationPermissionSettlement>;
  /** Capture returns an opaque, device-local value; it is never transported. */
  capturePosition: (run: LocationRunProjectionV1) => Promise<unknown>;
  /** Retain a fix only after it arrived inside the bounded capture window. */
  retainPosition: (capture: unknown, run: LocationRunProjectionV1) => Promise<boolean>;
  /** Save through the page's encrypted-draft + v5 finalizer path. */
  savePlace: (input: {
    run: LocationRunProjectionV1;
    category: "home" | "work" | "other";
    label: string;
  }) => Promise<boolean | LocationOnboardingRunResultV1>;
  /** Open the approved form only when a retained fix is available. */
  openPlaceForm: (input?: {
    runId: string;
    category: "other";
  }) => Promise<boolean>;
  openSettings: (run?: LocationRunProjectionV1) => Promise<void>;
  /** Remove the Location-scoped ciphertext and device key after server skip. */
  discardPreparedDraft: (runId: string) => Promise<void>;
  showReady: (run?: LocationRunProjectionV1) => void;
  openLocation: () => void;
};

/**
 * Binds server-issued Location directives to real device/UI interactions.
 *
 * This class never creates a run, directive id, lease, or settlement result.
 * It can only execute the bounded operation selected by a parsed server
 * contract and passes every transition through the run client again.
 */
export class OneLocationOnboardingDeviceOrchestrator {
  private epoch = 0;
  private automaticDirectiveId: string | null = null;
  private permissionRequest: symbol | null = null;

  constructor(
    private readonly surface: OneLocationInteractionSurfacePort,
    private readonly device: OneLocationDeviceInteractionPort,
  ) {}

  cancel(): void {
    this.epoch += 1;
    this.automaticDirectiveId = null;
    this.permissionRequest = null;
  }

  async startOrResume(contextRevision?: string | null): Promise<void> {
    if (this.device.requestedPrivateSetup?.()) {
      await this.device.resumeRequestedWorkflow?.();
      return;
    }
    const epoch = ++this.epoch;
    try {
      const result = await this.surface.startOrResume(contextRevision);
      if (epoch !== this.epoch) return;
      this.present(result);
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(this.surface.currentRun);
    }
  }

  present(
    result: LocationOnboardingRunResultV1,
    primedPosition?: Promise<BoundedLocationInteractionResult<unknown>>,
  ): void {
    const directive = result.directive;
    if (!directive) {
      if (
        result.run.status === "verified_succeeded" &&
        result.run.completionClaimAllowed
      ) {
        this.surface.dismiss();
        this.device.showReady(result.run);
        return;
      }
      this.publishRecovery(result.run);
      return;
    }

    const pause = () => this.advance(result.run, "pause");
    switch (directive.contractId) {
      case "one.location.introduction.v2":
        this.surface.presentServerResult(result, {
          onResult: {
            continue: () => this.advance(result.run, "continue"),
            pause,
          },
        });
        return;
      case "one.location.permission_offer.v2":
        this.surface.presentServerResult(result, {
          // The server first records that the person accepted the technical
          // interaction. The resulting permission_result lease is then used
          // to settle the real OS outcome from this same trusted tap.
          onResult: {
            request_permission: () => this.requestPermission(result.run),
            pause,
          },
        });
        if (this.device.requestedPrivateSetup?.() && this.device.observePermission) {
          const epoch = this.epoch;
          void this.device.observePermission(result.run).then((permission) => {
            if (epoch === this.epoch && permission === "permission_granted") void this.requestPermission(result.run, permission);
          }).catch(() => undefined);
        }
        return;
      case "one.location.paused.v2":
        this.surface.presentServerResult(result, {
          onResult: { resume: () => this.advance(result.run, "resume") },
        });
        return;
      case "one.location.permission_result.v2":
        this.surface.presentServerResult(result, {
          // If the app was interrupted after accepting the permission offer,
          // this server-registered button restores a trusted tap. The OS
          // request starts immediately and its outcome settles only on the
          // fresh permission-result lease returned by retry_permission.
          onResult: {
            retry_permission: () => this.retryPermission(result.run),
            pause,
          },
        });
        return;
      case "one.location.settings_return.v2":
        this.surface.presentServerResult(result, {
          onResult: {
            open_settings: () => this.openSettings(result.run),
            retry_permission: () => this.retryPermission(result.run),
            pause,
          },
        });
        return;
      case "one.location.position_pending.v2":
        this.surface.presentServerResult(result, { onResult: { pause } });
        this.beginPositionCapture(result, primedPosition);
        return;
      case "one.location.position_retry.v2":
        this.surface.presentServerResult(result, {
          onResult: {
            retry_position: () => this.advance(result.run, "retry_position"),
            pause,
          },
        });
        return;
      case "one.location.place_choice.v2":
        if (this.device.requestedPrivateSetup?.()) {
          if (this.automaticDirectiveId !== directive.directiveId) {
            this.automaticDirectiveId = directive.directiveId;
            void this.choosePlace(result.run);
          }
          return;
        }
        this.surface.presentServerResult(result, {
          onResult: {
            save_place: () => this.choosePlace(result.run),
            skip_place: () => this.advance(result.run, "skip_place"),
            pause,
          },
        });
        return;
      case "one.location.place_persisting.v2":
        if (this.device.requestedPrivateSetup?.()) {
          this.saveRequestedPlace(result);
          return;
        }
        this.surface.presentServerResult(result, { onResult: { pause } });
        void this.openPlaceForm(result.run);
        return;
      case "one.location.awaiting_vault_finalize.v2":
        if (this.device.requestedPrivateSetup?.()) {
          this.saveRequestedPlace(result);
          return;
        }
        this.surface.presentServerResult(result, {
          onResult: {
            skip_place: () => this.skipPreparedPlace(result.run),
            pause,
          },
        });
        return;
      case "one.location.circle_retry.v2":
        this.surface.presentServerResult(result, {
          onResult: {
            retry_circle: () => this.advance(result.run, "retry_circle"),
            pause,
          },
        });
        return;
      case "one.location.completion_retry.v2":
        this.surface.presentServerResult(result, {
          onResult: {
            retry_completion: () =>
              this.advance(result.run, "retry_completion"),
            pause,
          },
        });
        return;
      case "one.location.already_complete.v2":
        this.surface.presentServerResult(result, {
          onResult: {
            open_location: () => this.openVerifiedLocation(result.run),
            pause,
          },
        });
        return;
    }
  }

  private publishRecovery(run: LocationRunProjectionV1 | null): void {
    this.surface.publishLocal("resume_required", {
      run,
      onPrimary: () => this.device.requestedPrivateSetup?.()
        ? this.device.resumeRequestedWorkflow?.() : this.startOrResume(),
    });
  }

  private saveRequestedPlace(result: LocationOnboardingRunResultV1): void {
    if (!result.directive || this.automaticDirectiveId === result.directive.directiveId) return;
    this.automaticDirectiveId = result.directive.directiveId;
    const epoch = ++this.epoch;
    void this.device.savePlace({ run: result.run, category: "other", label: "Current location" }).then((next) => {
      if (epoch !== this.epoch) return;
      // Only a server run projection continues the workflow. A local boolean
      // cannot establish an encrypted save or completion receipt.
      if (typeof next === "object") this.present(next);
      else this.publishRecovery(result.run);
    }).catch((error: unknown) => {
      if (epoch !== this.epoch) return;
      if (error instanceof LocationSaveOutcomeUnknown && this.device.reviewRequestedSave) {
        this.device.reviewRequestedSave(result.run.runId);
        return;
      }
      this.publishRecovery(result.run);
    });
  }

  private async advance(
    run: LocationRunProjectionV1,
    result: string,
  ): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const next = await this.surface.settle({ run, result });
      if (epoch !== this.epoch) return;
      this.present(next);
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    }
  }

  private async requestPermission(run: LocationRunProjectionV1, observed?: "permission_granted"): Promise<void> {
    if (this.permissionRequest) return;
    const ticket = Symbol();
    this.permissionRequest = ticket;
    const epoch = ++this.epoch;
    // Invoke the native/browser permission API synchronously inside the
    // trusted button handler. The server transition runs concurrently so its
    // network latency cannot delay the OS prompt.
    recordLocationPermissionRequestStarted(run);
    const permission = OneLocationOnboardingRunClient.settleWithin(
      observed ? Promise.resolve(observed) : this.device.requestPermission(run),
    );
    void permission.catch(() => undefined);
    try {
      const permissionResult = await this.surface.settle({
        run,
        result: "request_permission",
      });
      if (epoch !== this.epoch) return;
      this.surface.presentServerResult(permissionResult);
      await this.settlePermissionResult(
        permissionResult.run,
        epoch,
        permission,
      );
    } catch {
      void permission.catch(() => undefined);
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    } finally {
      if (this.permissionRequest === ticket) this.permissionRequest = null;
    }
  }

  private async retryPermission(run: LocationRunProjectionV1): Promise<void> {
    if (this.permissionRequest) return;
    const ticket = Symbol();
    this.permissionRequest = ticket;
    const epoch = ++this.epoch;
    recordLocationPermissionRequestStarted(run);
    const permission = OneLocationOnboardingRunClient.settleWithin(
      this.device.requestPermission(run),
    );
    void permission.catch(() => undefined);
    try {
      const permissionResult = await this.surface.settle({
        run,
        result: "retry_permission",
      });
      if (epoch !== this.epoch) return;
      this.surface.presentServerResult(permissionResult);
      await this.settlePermissionResult(
        permissionResult.run,
        epoch,
        permission,
      );
    } catch {
      void permission.catch(() => undefined);
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    } finally {
      if (this.permissionRequest === ticket) this.permissionRequest = null;
    }
  }

  private async settlePermissionResult(
    run: LocationRunProjectionV1,
    inheritedEpoch?: number,
    primedPermission?: Promise<
      BoundedLocationInteractionResult<LocationPermissionSettlement>
    >,
  ): Promise<void> {
    const epoch = inheritedEpoch ?? ++this.epoch;
    try {
      const permission = await (primedPermission ??
        OneLocationOnboardingRunClient.settleWithin(
          this.device.requestPermission(run),
        ));
      if (epoch !== this.epoch) return;
      if (permission.status === "timed_out") {
        this.surface.publishLocal("permission_required", {
          run,
          onPrimary: () => this.startOrResume(),
        });
        return;
      }
      markLocationPermissionResultObserved(run, permission.value);
      // Start the first GPS fix immediately after the real grant, before the
      // permission settlement roundtrip. The resulting position_pending lease
      // consumes this exact bounded promise and never asks the device twice.
      let primedPosition:
        Promise<BoundedLocationInteractionResult<unknown>> | undefined;
      if (permission.value === "permission_granted") {
        recordLocationPositionCaptureStarted(run);
        primedPosition = OneLocationOnboardingRunClient.settleWithin(
          this.device.capturePosition(run),
        );
      }
      void primedPosition?.catch(() => undefined);
      const next = await this.surface.settle({
        run,
        result: permission.value,
      });
      if (epoch !== this.epoch) return;
      this.present(next, primedPosition);
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    }
  }

  private async openSettings(run: LocationRunProjectionV1): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const waitingForReturn = await this.surface.settle({
        run,
        result: "open_settings",
      });
      if (epoch !== this.epoch) return;
      // Keep the approved Settings recovery directive live while the app is
      // away. Foreground refresh re-reads this same server run and the owning
      // Location page rebinds its registered actions; no generic paused card
      // or model-generated instruction is inserted between OS state and retry.
      this.present(waitingForReturn);
      await this.device.openSettings(run);
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    }
  }

  private beginPositionCapture(
    result: LocationOnboardingRunResultV1,
    primedPosition?: Promise<BoundedLocationInteractionResult<unknown>>,
  ): void {
    const directive = result.directive;
    if (!directive || this.automaticDirectiveId === directive.directiveId) {
      return;
    }
    this.automaticDirectiveId = directive.directiveId;
    const epoch = ++this.epoch;
    void (async () => {
      try {
        const captured = await (primedPosition ??
          OneLocationOnboardingRunClient.settleWithin(
            this.device.capturePosition(result.run),
          ));
        if (epoch !== this.epoch) return;
        if (captured.status === "timed_out") {
          // No fix arrived inside the product's bounded device window. That
          // is the exact server result (not a guessed permission failure), so
          // consume the active lease and let the runtime issue position_retry.
          const next = await this.surface.settle({
            run: result.run,
            result: "position_unavailable",
          });
          if (epoch !== this.epoch) return;
          this.present(next);
          return;
        }
        const point = parseFreshLocationRuntimeCapture(captured.value);
        const retained = point
          ? await this.device.retainPosition(point, result.run)
          : false;
        if (epoch !== this.epoch) return;
        const next = await this.surface.settle({
          run: result.run,
          result: retained ? "position_captured" : "position_unavailable",
          ...(retained && point
            ? {
                positionObservation: {
                  schemaVersion: "one.location_position_observation.v1",
                  permissionStatus: "granted",
                  capturedAt: point.capturedAt,
                  sourcePlatform: point.sourcePlatform,
                },
              }
            : {}),
        });
        if (epoch !== this.epoch) return;
        this.present(next);
      } catch {
        if (epoch !== this.epoch) return;
        try {
          const next = await this.surface.settle({
            run: result.run,
            result: "position_unavailable",
          });
          if (epoch !== this.epoch) return;
          this.present(next);
        } catch {
          if (epoch !== this.epoch) return;
          this.publishRecovery(result.run);
        }
      }
    })();
  }

  private async choosePlace(run: LocationRunProjectionV1): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const next = await this.surface.settle({ run, result: "save_place" });
      if (epoch !== this.epoch) return;
      this.present(next);
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    }
  }

  private async skipPreparedPlace(run: LocationRunProjectionV1): Promise<void> {
    const epoch = ++this.epoch;
    let next: LocationOnboardingRunResultV1;
    try {
      // The server consumes the one-time lease first. Only an accepted skip
      // authorizes deletion of this run's device-only Location draft.
      next = await this.surface.settle({ run, result: "skip_place" });
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
      return;
    }
    if (epoch !== this.epoch) return;
    try {
      await this.device.discardPreparedDraft(run.runId);
      if (epoch !== this.epoch) return;
      this.present(next);
    } catch {
      if (epoch !== this.epoch) return;
      // Never show the downstream/success state while private draft cleanup
      // is unresolved. The server lease was already consumed, so retry only
      // the local key/ciphertext deletion and never submit skip twice.
      this.publishPreparedDraftCleanupRecovery(next);
    }
  }

  private publishPreparedDraftCleanupRecovery(
    next: LocationOnboardingRunResultV1,
  ): void {
    this.surface.publishLocal("secure_task_unavailable", {
      run: next.run,
      dismissible: false,
      onPrimary: () => this.retryPreparedDraftCleanup(next),
    });
  }

  private async retryPreparedDraftCleanup(
    next: LocationOnboardingRunResultV1,
  ): Promise<void> {
    const epoch = ++this.epoch;
    try {
      await this.device.discardPreparedDraft(next.run.runId);
      if (epoch !== this.epoch) return;
      this.present(next);
    } catch {
      if (epoch !== this.epoch) return;
      this.publishPreparedDraftCleanupRecovery(next);
    }
  }

  private async openPlaceForm(
    run: LocationRunProjectionV1,
    input?: { runId: string; category: "other" },
  ): Promise<boolean> {
    const epoch = ++this.epoch;
    try {
      if (await this.device.openPlaceForm(input)) return true;
      const captured = await OneLocationOnboardingRunClient.settleWithin(
        this.device.capturePosition(run),
      );
      if (epoch !== this.epoch) return false;
      if (
        captured.status === "settled" &&
        (await this.device.retainPosition(captured.value, run)) &&
        epoch === this.epoch &&
        (await this.device.openPlaceForm(input))
      ) {
        return true;
      }
    } catch {
      if (epoch !== this.epoch) return false;
    }
    this.surface.publishLocal("capture_retry", {
      run,
      onPrimary: () => this.openPlaceForm(run, input),
    });
    return false;
  }

  private async openVerifiedLocation(
    run: LocationRunProjectionV1,
  ): Promise<void> {
    const epoch = ++this.epoch;
    try {
      await this.surface.settle({ run, result: "open_location" });
      if (epoch !== this.epoch) return;
      this.device.openLocation();
    } catch {
      if (epoch !== this.epoch) return;
      this.publishRecovery(run);
    }
  }
}
