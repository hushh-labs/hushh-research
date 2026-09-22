import { describe, expect, it, vi } from "vitest";

import {
  OneLocationOnboardingDeviceOrchestrator,
  LocationSaveOutcomeUnknown,
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

it("permission callbacks survive collapse without dispatching the same OS prompt twice", async () => {
  const current = run({ evidence: { permission: false, place: false, circle: false, completion: false } });
  const { surface, device } = harness(current);
  let finish!: (value: LocationOnboardingRunResultV1) => void;
  vi.mocked(surface.settle).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  vi.mocked(device.requestPermission).mockResolvedValue("permission_granted");
  const orchestrator = new OneLocationOnboardingDeviceOrchestrator(surface, device);
  orchestrator.present(result(current, "one.location.permission_offer.v2"));
  const actions = vi.mocked(surface.presentServerResult).mock.calls.at(-1)![1]!.onResult!;
  const first = actions.request_permission!();
  await actions.request_permission!();
  expect(device.requestPermission).toHaveBeenCalledTimes(1);
  expect(surface.settle).toHaveBeenCalledTimes(1);
  orchestrator.cancel();
  finish(result(current, "one.location.permission_result.v2"));
  await first;
  expect(surface.settle).toHaveBeenCalledTimes(1);
  expect(device.capturePosition).not.toHaveBeenCalled();
});

it("uses a granted permission observation without opening another permission prompt", async () => {
  const current = run();
  const { surface, device } = harness(current);
  device.requestedPrivateSetup = () => true;
  device.observePermission = vi.fn().mockResolvedValue("permission_granted");
  vi.mocked(surface.settle).mockReturnValue(new Promise(() => {}));
  const orchestrator = new OneLocationOnboardingDeviceOrchestrator(surface, device);
  orchestrator.present(result(current, "one.location.permission_offer.v2"));
  await vi.waitFor(() => expect(surface.settle).toHaveBeenCalledWith({ run: expect.objectContaining({ runId: current.runId }), result: "request_permission" }));
  expect(device.requestPermission).not.toHaveBeenCalled();
  orchestrator.cancel();
});

it("unknown saves open review and never become success or an automatic retry", async () => {
  const current = run();
  const { surface, device } = harness(current);
  device.requestedPrivateSetup = () => true;
  device.reviewRequestedSave = vi.fn();
  vi.mocked(device.savePlace).mockRejectedValue(new LocationSaveOutcomeUnknown());
  const orchestrator = new OneLocationOnboardingDeviceOrchestrator(surface, device);
  const pending = result(current, "one.location.awaiting_vault_finalize.v2");
  orchestrator.present(pending);
  await vi.waitFor(() => expect(device.reviewRequestedSave).toHaveBeenCalledWith(current.runId));
  orchestrator.present(pending);
  expect(device.savePlace).toHaveBeenCalledTimes(1);
  expect(device.showReady).not.toHaveBeenCalled();
  expect(surface.publishLocal).not.toHaveBeenCalled();
});

it("discarded saves cannot reopen a recovery card", async () => {
  const current = run();
  const { surface, device } = harness(current);
  device.requestedPrivateSetup = () => true;
  let reject!: (reason: Error) => void;
  vi.mocked(device.savePlace).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  const orchestrator = new OneLocationOnboardingDeviceOrchestrator(surface, device);
  orchestrator.present(result(current, "one.location.awaiting_vault_finalize.v2"));
  orchestrator.cancel();
  reject(new Error("late failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(surface.publishLocal).not.toHaveBeenCalled();
  expect(device.showReady).not.toHaveBeenCalled();
});
