import { describe, expect, it, vi } from "vitest";

import {
  OneLocationOnboardingDeviceOrchestrator,
  type OneLocationDeviceInteractionPort,
  type OneLocationInteractionSurfacePort,
} from "@/lib/services/one-location-onboarding-device-orchestrator";
import type {
  LocationOnboardingRunResultV1,
  LocationRunProjectionV1,
} from "@/lib/services/one-location-onboarding-run-client";

function run(
  overrides: Partial<LocationRunProjectionV1> = {},
): LocationRunProjectionV1 {
  return {
    schemaVersion: "one.location_run_projection.v1",
    workflowId: "workflow.setup.location",
    workflowVersion: 2,
    graphRevision: "a".repeat(64),
    runId: "run_abcdefghijklmnop",
    revision: 1,
    status: "interaction_required",
    cursor: "location.onboarding.place",
    completionClaimAllowed: false,
    pendingDirective: null,
    evidence: {
      permission: true,
      place: true,
      circle: true,
      completion: false,
    },
    draft: null,
    pkmFinalizeAuthorization: null,
    ...overrides,
  };
}

function result(
  currentRun: LocationRunProjectionV1,
  contractId: string | null,
): LocationOnboardingRunResultV1 {
  const directive = contractId
    ? ({
        schemaVersion: "one.location_interaction_directive.v1",
        directiveId: "locdirective_abcdefghijklmnop",
        contractId,
        kind: "status",
        surfaceId: "render.one_location_workflow_card",
        titleKey: "one.location.awaiting_vault_finalize.title",
        bodyKey: "one.location.awaiting_vault_finalize.body",
        allowedResults: ["pause"],
        expiresAt: "2099-09-10T00:00:00.000Z",
        lease: { leaseId: "loclease_abcdefghijklmnop", runRevision: 1 },
      } as unknown as LocationOnboardingRunResultV1["directive"])
    : null;
  return {
    schemaVersion: "one.location_onboarding_run_result.v1",
    run: { ...currentRun, pendingDirective: directive },
    directive,
    waitingReason: null,
  };
}

function harness(initialRun: LocationRunProjectionV1) {
  const surface = {
    currentRun: initialRun,
    startOrResume: vi.fn(),
    settle: vi.fn(),
    presentServerResult: vi.fn(),
    publishLocal: vi.fn(),
    dismiss: vi.fn(),
  } as unknown as OneLocationInteractionSurfacePort;
  const device = {
    requestPermission: vi.fn(),
    capturePosition: vi.fn(),
    retainPosition: vi.fn(),
    savePlace: vi.fn(),
    openPlaceForm: vi.fn(),
    openSettings: vi.fn(),
    discardPreparedDraft: vi.fn(),
    showReady: vi.fn(),
    openLocation: vi.fn(),
  } as unknown as OneLocationDeviceInteractionPort;
  return { surface, device };
}

describe("OneLocationOnboardingDeviceOrchestrator completion claims", () => {
  it("never renders Location ready while a pre-vault draft awaits final verification", () => {
    const awaiting = run({
      status: "interaction_required",
      completionClaimAllowed: false,
    });
    const { surface, device } = harness(awaiting);
    const orchestrator = new OneLocationOnboardingDeviceOrchestrator(
      surface,
      device,
    );

    orchestrator.present(result(awaiting, "one.location.awaiting_vault_finalize.v2"));

    expect(surface.presentServerResult).toHaveBeenCalledOnce();
    expect(device.showReady).not.toHaveBeenCalled();
  });

  it("renders Location ready only after a verified server settlement", () => {
    const verified = run({
      status: "verified_succeeded",
      completionClaimAllowed: true,
      cursor: "location.onboarding.complete",
      evidence: {
        permission: true,
        place: true,
        circle: true,
        completion: true,
      },
    });
    const { surface, device } = harness(verified);
    const orchestrator = new OneLocationOnboardingDeviceOrchestrator(
      surface,
      device,
    );

    orchestrator.present(result(verified, null));

    expect(surface.dismiss).toHaveBeenCalledOnce();
    expect(device.showReady).toHaveBeenCalledOnce();
  });
});
