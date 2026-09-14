import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  api: vi.fn(),
  permission: vi.fn(),
  requestPermission: vi.fn(),
  capture: vi.fn(),
  save: vi.fn(),
  execute: vi.fn(),
  settle: vi.fn(),
  get: vi.fn(),
  session: { busyOperations: {}, setAnalysisParams: vi.fn() },
  user: { uid: "owner" },
  vault: {
    isVaultUnlocked: true,
    vaultKey: "12".repeat(32),
    vaultOwnerToken: "synthetic-owner-token",
  },
  popover: {
    expanded: false,
    motionState: "closed",
    minimizeAgent: vi.fn(),
    openAgent: vi.fn(),
  },
  router: { push: vi.fn(), replace: vi.fn() },
  pageAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => h.router,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: h.user, userId: h.user.uid }),
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => h.vault }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ switchPersona: vi.fn() }),
}));
vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (select: (x: unknown) => unknown) => select(h.session),
}));
vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => h.popover,
}));
vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeStateOptional: () => ({
    appRuntimeState: {
      route: {
        get pathname() {
          return window.location.pathname + window.location.search;
        },
      },
      portfolio: { has_portfolio_data: false },
    },
    oneVoiceContextSnapshot: {
      executable_action_ids: ["location.resume_updates"],
    },
  }),
}));
vi.mock("@capacitor/core", async (load) => ({
  ...(await load<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));
vi.mock("@capacitor/app", () => ({ App: {} }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: h.api },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdTokenWithRetry: async () => "synthetic-id-token" },
}));
vi.mock("@/lib/agent/one-system-action-executor", () => ({
  registerOneSystemActionExecutor: () => () => undefined,
}));
vi.mock("@/lib/agent/agent-action-runtime", () => ({
  executeAgentGatewayAction: h.execute,
}));
vi.mock("@/lib/agent/agent-gateway-action-settlement", () => ({
  settleAgentGatewayAction: async (result: unknown) => result,
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  getVoiceSurfaceMetadata: vi.fn(),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConnectionGraphMutated: vi.fn() },
}));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: { load: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getPermissionState: h.permission,
    requestLocationPermission: h.requestPermission,
    captureCurrentPosition: h.capture,
  },
}));
vi.mock("@/lib/one-location/saved-locations", () => ({
  saveRequestedLocationWorkflowPlace: h.save,
}));
vi.mock("@/lib/services/location-circle-name-interaction-client", () => ({
  fetchActiveLocationCircleNameDirective: async () => null,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/components/navbar", () => ({ Navbar: () => null }));
vi.mock("@/components/app-ui/ambient-chrome-mask", () => ({
  AmbientChromeMask: () => null,
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: ({ href }: { href: string }) => {
    window.history.replaceState({}, "", href);
    return true;
  },
}));
vi.mock("@/lib/agent/local-onboarding-actions", async (load) => {
  const actual =
    await load<typeof import("@/lib/agent/local-onboarding-actions")>();
  return {
    ...actual,
    hasMountedLocalOnboardingHandler: () => true,
    prepareLocalOnboardingAction: async () => ({
      status: "ready",
      binding: { owner: "owner" },
      summary: "Enable Location",
    }),
  };
});

import { OneLocationInteractionSurfaceProvider } from "@/components/one-location/onboarding/location-onboarding-interaction-surface";
import {
  LocationCommandProvider,
  useLocationCommand,
} from "@/components/agent/location-command-provider";
import { LocationCommandDeviceBridge } from "@/components/one-location/onboarding/location-command-device-bridge";
import { AppBottomShell } from "@/components/app-ui/app-bottom-shell";
import { ONE_LOCATION_WORKFLOW_CARD_CATALOG } from "@/lib/generated/one-location-workflow-card-catalog.v1";
import {
  ONE_LOCATION_SERVER_DIRECTIVE_CATALOG,
  OneLocationOnboardingRunClient,
  parseLocationOnboardingRunResult,
  type LocationOnboardingRunResultV1,
  type LocationServerDirectiveContractId,
} from "@/lib/services/one-location-onboarding-run-client";
import { decryptData } from "@/lib/vault/encrypt";
import { locationFinalizeWire } from "@/lib/one-location/pkm-finalize-authorization";

const commandId = "00000000-0000-4000-8000-000000000001";
const runId = "run_" + "b".repeat(32);
const deadline = () => new Date(Date.now() + 3_600_000).toISOString();
let checkpoint: any;
let completed = false;
let finalizer: LocationOnboardingRunResultV1 | null = null;
const calls: Array<{ path: string; body: any }> = [];

function projection(
  contractId: LocationServerDirectiveContractId | null,
  revision: number,
): LocationOnboardingRunResultV1 {
  const contract = contractId
    ? ONE_LOCATION_SERVER_DIRECTIVE_CATALOG[contractId]
    : null;
  const directive = contract && {
    schemaVersion: "one.location_interaction_directive.v1",
    directiveId: "locdirective_" + String(revision).padStart(32, "0"),
    contractId,
    kind: contract.kind,
    surfaceId: "render.one_location_workflow_card",
    titleKey: contract.titleKey,
    bodyKey: contract.bodyKey,
    allowedResults: [...contract.allowedResults],
    expiresAt: deadline(),
    lease: {
      leaseId: "loclease_" + String(revision).padStart(32, "0"),
      runRevision: revision,
    },
  };
  const value = {
    schemaVersion: "one.location_onboarding_run_result.v1",
    directive,
    run: {
      schemaVersion: "one.location_run_projection.v1",
      workflowId: "workflow.setup.location",
      workflowVersion: 2,
      graphRevision: ONE_LOCATION_WORKFLOW_CARD_CATALOG.graphRevision,
      runId,
      revision,
      status: contract ? "interaction_required" : "verified_succeeded",
      cursor:
        revision < 3
          ? "location.onboarding.permission"
          : revision === 3
            ? "location.onboarding.position"
            : revision < 6
              ? "location.onboarding.place"
              : "location.onboarding.complete",
      completionClaimAllowed: !contract,
      pendingDirective: directive,
      commandBinding: {
        commandId,
        commandStep: 0,
        operationId: "a".repeat(64),
      },
      evidence: {
        permission: revision >= 3,
        place: !contract,
        circle: !contract,
        completion: !contract,
      },
      draft: null,
      pkmFinalizeAuthorization: null,
    },
    waitingReason: null,
  };
  const parsed = parseLocationOnboardingRunResult(value);
  if (!parsed) throw new Error("Invalid synthetic workflow projection");
  return parsed;
}
function Controls() {
  const context = useLocationCommand();
  return (
    <>
      <button
        onClick={() => context.run(context.command.submit("Do my Location onboarding"))}
      >
        Begin command
      </button>
      <button onClick={() => context.cancelTask()}>Stop task</button>
      <button onClick={h.pageAction}>Page action</button>
    </>
  );
}

it("preserves the server's microsecond expiry through parsing and private-save serialization", () => {
  const value = projection("one.location.awaiting_vault_finalize.v2", 6);
  const expiresAt = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, ".123456+00:00");
  value.run.draft = {
    draftRef: "locdraft_" + "c".repeat(32),
    status: "staged",
    expiresAt: deadline(),
  };
  value.run.pkmFinalizeAuthorization = {
    schemaVersion: "one.location_pkm_finalize_authorization.v1",
    authorizationId: "locpkmauth_" + "d".repeat(32),
    token: "locpkmtoken_" + "d".repeat(32) + "_" + "e".repeat(64),
    runId,
    runRevision: 6,
    leaseId: value.directive!.lease.leaseId,
    directiveId: value.directive!.directiveId,
    draftRef: value.run.draft.draftRef,
    draftDigest: "a".repeat(64),
    expectedCommitId: "00000000-0000-4000-8000-000000000002",
    expiresAt,
  };
  const parsed = parseLocationOnboardingRunResult({
    ...value,
    run: {
      ...value.run,
      pkmFinalizeAuthorization: locationFinalizeWire(value.run.pkmFinalizeAuthorization),
    },
  });
  const reparsed = parseLocationOnboardingRunResult(parsed);
  for (const result of [parsed, reparsed]) {
    expect(result?.run.pkmFinalizeAuthorization).toBeTruthy();
    expect(locationFinalizeWire(result!.run.pkmFinalizeAuthorization!).expires_at).toBe(expiresAt);
  }
});
function App() {
  return (
    <OneLocationInteractionSurfaceProvider>
      <LocationCommandProvider>
        <LocationCommandDeviceBridge />
        <Controls />
        <AppBottomShell
          model={{
            hidden: false,
            navigationHidden: false,
            ambientEnabled: false,
          }}
        />
      </LocationCommandProvider>
    </OneLocationInteractionSurfaceProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  window.history.replaceState({}, "", "/one/agents");
  h.vault.isVaultUnlocked = true;
  completed = false;
  finalizer = null;
  calls.length = 0;
  checkpoint = {
    command_id: commandId,
    revision: 1,
    next_step: 0,
    step_count: 2,
    status: "ready",
    capsule: null,
    expires_at: deadline(),
  };
  vi.spyOn(OneLocationOnboardingRunClient, "readProjection").mockResolvedValue(
    null,
  );
  vi.spyOn(
    OneLocationOnboardingRunClient,
    "rememberProjection",
  ).mockImplementation(async (_owner, run) => run);
  vi.spyOn(OneLocationOnboardingRunClient, "clearProjection").mockResolvedValue(
    undefined,
  );
  vi.spyOn(OneLocationOnboardingRunClient, "findActive").mockResolvedValue(
    null,
  );
  vi.spyOn(OneLocationOnboardingRunClient, "settle").mockImplementation(
    h.settle,
  );
  vi.spyOn(OneLocationOnboardingRunClient, "get").mockImplementation(h.get);
  h.permission.mockResolvedValue({
    state: "granted",
    locationServicesEnabled: true,
  });
  h.requestPermission.mockResolvedValue({
    state: "granted",
    locationServicesEnabled: true,
  });
  h.capture.mockImplementation(async () => ({
    latitude: 10,
    longitude: 20,
    accuracyM: 5,
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web",
  }));
  h.get.mockImplementation(async () =>
    completed ? projection(null, (finalizer?.run.revision ?? 6) + 1) : finalizer,
  );
  h.save.mockImplementation(async ({ beforeEffect }) => {
    await beforeEffect();
    completed = true;
    return { conflict: false };
  });
  h.execute.mockResolvedValue({
    status: "succeeded",
    resultSummary: "Location is on.",
  });
  h.settle.mockImplementation(async ({ result, draftMetadata }) => {
    if (result === "draft_prepared") {
      finalizer = projection("one.location.awaiting_vault_finalize.v2", 6);
      finalizer.run.draft = {
        draftRef: "locdraft_" + "c".repeat(32),
        status: "staged",
        expiresAt: deadline(),
      };
      finalizer.run.pkmFinalizeAuthorization = {
        schemaVersion: "one.location_pkm_finalize_authorization.v1",
        authorizationId: "locpkmauth_" + "d".repeat(32),
        token: "locpkmtoken_" + "d".repeat(32) + "_" + "e".repeat(64),
        runId,
        runRevision: 6,
        leaseId: finalizer.directive!.lease.leaseId,
        directiveId: finalizer.directive!.directiveId,
        draftRef: finalizer.run.draft.draftRef,
        draftDigest: draftMetadata.digest,
        expectedCommitId: "00000000-0000-4000-8000-000000000002",
        expiresAt: finalizer.directive!.expiresAt,
      };
      return finalizer;
    }
    const next = (
      {
        request_permission: ["one.location.permission_result.v2", 2],
        permission_granted: ["one.location.position_pending.v2", 3],
        position_captured: ["one.location.place_choice.v2", 4],
        save_place: ["one.location.place_persisting.v2", 5],
      } as const
    )[result as "request_permission"];
    if (!next) throw new Error("Unexpected synthetic transition");
    return projection(next[0], next[1]);
  });
  h.api.mockImplementation(async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    let response: unknown;
    if (path.endsWith(`/workflows/location/onboarding/runs/${runId}`)) {
      // Workflow receipts require Firebase identity; a vault-owner capability
      // is only accepted by the private PKM operation, not this endpoint.
      if (new Headers(init.headers).get("Authorization") !== "Bearer synthetic-id-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      response = completed ? projection(null, (finalizer?.run.revision ?? 6) + 1) : finalizer;
    } else if (path.endsWith("agent-chat/proposals"))
      response = {
        checkpoint,
        plan: {
          schema_version: "location.plan.v2",
          capability_revision: "cap",
          context_revision: "context",
          mode: "end_to_end",
          gate: null,
          steps: [
            { workflow_id: "workflow.setup.location", slots: {} },
            { action_id: "location.resume_updates", slots: {} },
          ],
        },
      };
    else if (path.endsWith("/checkpoint")) {
      checkpoint = {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        capsule: body.capsule,
      };
      response = { checkpoint };
    } else if (path.endsWith("/admit") || path.endsWith("/resume")) {
      if (completed && checkpoint.next_step === 0) {
        checkpoint = { ...checkpoint, next_step: 1 };
        response = { status: "advanced", checkpoint };
      } else
        response = {
          status: "ready",
          directive: {
            directive_id: "dir",
            operation_id: "op",
            context_revision: "context",
          },
        };
    } else if (path.endsWith("/execute"))
      response = {
        status: "workflow",
        workflow: projection("one.location.permission_offer.v2", 1),
        checkpoint,
      };
    else if (path.endsWith("/claim"))
      response = {
        directive_id: "dir",
        operation_id: "op",
        execution_receipt: "receipt",
        effect: "action",
      };
    else if (path.endsWith("/settle")) {
      checkpoint = {
        ...checkpoint,
        next_step: 2,
        status: "completed",
        capsule: null,
      };
      response = { checkpoint };
    } else if (path.endsWith(commandId)) response = { checkpoint };
    else response = { commands: [] };
    return new Response(JSON.stringify(response), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("continues a permission settlement while the bridge binds its rendered callbacks", async () => {
  const settle = h.settle.getMockImplementation()!;
  let releasePermission!: () => void;
  const permissionResponse = new Promise<void>((resolve) => {
    releasePermission = resolve;
  });
  h.settle.mockImplementation(async (input) => {
    if (input.result === "permission_granted") await permissionResponse;
    return settle(input);
  });
  render(<App />);
  fireEvent.click(screen.getByText("Begin command"));
  await waitFor(() =>
    expect(h.settle).toHaveBeenCalledWith(
      expect.objectContaining({ result: "permission_granted" }),
    ),
  );
  // A real network response arrives after the rendered directive's effects.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    releasePermission();
  });
  await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(window.location.pathname).toBe("/one/location"));
  expect(h.capture).toHaveBeenCalledTimes(1);
  expect(checkpoint.capsule).toBeNull();
});

it("mounts the real workflow owners and finishes only after save proof and Location-on", async () => {
  vi.mocked(OneLocationOnboardingRunClient.get).mockRestore();
  render(<App />);
  fireEvent.click(screen.getByText("Begin command"));
  await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1), {
    timeout: 4000,
  });
  await waitFor(
    () =>
      expect(screen.getByText(/Location setup complete/)).toBeInTheDocument(),
    { timeout: 4000 },
  );
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.capture).toHaveBeenCalledTimes(1);
  expect(h.execute).toHaveBeenCalledWith(
    expect.objectContaining({ actionId: "location.resume_updates" }),
  );
  expect(window.location.pathname).toBe("/one/location");
  expect(checkpoint.capsule).toBeNull();
  expect(
    screen.getAllByRole("region", { name: "Location command" }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByText("Page action"));
  expect(h.pageAction).toHaveBeenCalledOnce();
  expect(calls.every(({ path }) => !/live|audio|adk/.test(path))).toBe(true);
  const firstCaptureCheckpoint = calls.filter(({ path }) =>
    path.endsWith("/checkpoint"),
  );
  const capsules = await Promise.all(
    firstCaptureCheckpoint.map(async ({ body }) =>
      JSON.parse(await decryptData(body.capsule, h.vault.vaultKey)),
    ),
  );
  expect(
    capsules.some(
      (capsule) =>
        capsule.workflow?.draft && !capsule.workflow?.commitDispatched,
    ),
  ).toBe(true);
});

it.each(["renewed", "no_proof", "checkpoint_failed"] as const)(
  "recovers an uncertain private save only after a checkpointed server fence: %s",
  async (mode) => {
    const api = h.api.getMockImplementation()!;
    let recovering = false;
    let renewed = false;
    h.api.mockImplementation(async (path, init) => {
      if (recovering && path.endsWith(commandId)) {
        return new Response(JSON.stringify({ checkpoint, outcome: { state: "consumed" } }));
      }
      if (recovering && !completed && path.endsWith("/resume")) {
        const current = finalizer!;
        finalizer = projection("one.location.awaiting_vault_finalize.v2", 8);
        finalizer.run.draft = current.run.draft;
        finalizer.run.pkmFinalizeAuthorization = {
          ...current.run.pkmFinalizeAuthorization!,
          runRevision: 8,
          leaseId: finalizer.directive!.lease.leaseId,
          directiveId: finalizer.directive!.directiveId,
        };
        renewed = true;
        return new Response(JSON.stringify({
          status: "workflow", workflow: finalizer, checkpoint,
          ...(mode !== "no_proof" ? { workflow_finalize_renewed: true } : {}),
        }));
      }
      if (renewed && mode === "checkpoint_failed" && path.endsWith("/checkpoint")) {
        return new Response("Checkpoint unavailable", { status: 503 });
      }
      return api(path, init);
    });
    h.save.mockImplementationOnce(async ({ beforeEffect }) => {
      await beforeEffect();
      throw new Error("Synthetic lost save response");
    });
    render(<App />);
    fireEvent.click(screen.getByText("Begin command"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh / Resume", exact: true })).toBeVisible());
    expect(h.save).toHaveBeenCalledTimes(1);
    recovering = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh / Resume", exact: true }));
    await waitFor(() => expect(renewed).toBe(true));
    if (mode === "renewed") {
      await waitFor(() => expect(window.location.pathname).toBe("/one/location"));
      expect(h.save).toHaveBeenCalledTimes(2);
      expect(checkpoint.capsule).toBeNull();
    } else {
      if (mode === "no_proof") {
        await waitFor(() => expect(h.get).toHaveBeenCalled());
      } else {
        await waitFor(() => expect(screen.getByText("The command could not continue. Refresh its checkpoint.")).toBeVisible());
      }
      expect(h.save).toHaveBeenCalledTimes(1);
      expect(checkpoint.capsule).not.toBeNull();
      const retained = JSON.parse(await decryptData(checkpoint.capsule, h.vault.vaultKey));
      expect(retained.workflow.commitDispatched).toBe(true);
    }
    expect(h.capture).toHaveBeenCalledTimes(1);
  },
);

it("keeps the page usable during permission and rejects a late permission result after cancellation", async () => {
  h.permission.mockResolvedValue({
    state: "prompt",
    locationServicesEnabled: true,
  });
  let allow!: (value: {
    state: string;
    locationServicesEnabled: boolean;
  }) => void;
  h.requestPermission.mockReturnValue(
    new Promise((resolve) => {
      allow = resolve;
    }),
  );
  render(<App />);
  fireEvent.click(screen.getByText("Begin command"));
  await waitFor(() =>
    expect(screen.getByText("Allow Location access")).toBeInTheDocument(),
  );
  expect(h.requestPermission).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Location setup: Continue",
      exact: true,
    }),
  );
  await waitFor(() => expect(h.requestPermission).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("Page action"));
  expect(h.pageAction).toHaveBeenCalledOnce();
  expect(
    screen.getAllByRole("region", { name: "Location command" }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByText("Stop task"));
  await act(async () => {
    allow({ state: "granted", locationServicesEnabled: true });
  });
  expect(h.capture).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  expect(
    h.settle.mock.calls.some(
      ([input]) => input.result === "permission_granted",
    ),
  ).toBe(false);
});

it("continues permission settlement when a foreground read returns the earlier run", async () => {
  h.permission.mockResolvedValue({ state: "prompt", locationServicesEnabled: true });
  let settleOffer!: (result: LocationOnboardingRunResultV1) => void;
  h.settle.mockImplementationOnce(() => new Promise((resolve) => { settleOffer = resolve; }));
  render(<App />);
  fireEvent.click(screen.getByText("Begin command"));
  await screen.findByText("Allow Location access");
  fireEvent.click(screen.getByRole("button", { name: "Location setup: Continue", exact: true }));
  await waitFor(() => expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ result: "request_permission" })));

  const permissionRun = h.settle.mock.calls[0][0].run;
  h.get.mockResolvedValueOnce({ schemaVersion: "one.location_onboarding_run_result.v1", run: permissionRun, directive: permissionRun.pendingDirective, waitingReason: null });
  const rememberedBefore = vi.mocked(OneLocationOnboardingRunClient.rememberProjection).mock.calls.length;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(OneLocationOnboardingRunClient.rememberProjection).toHaveBeenCalledTimes(rememberedBefore + 1));
  h.permission.mockResolvedValue({ state: "granted", locationServicesEnabled: true });
  await act(async () => { settleOffer(projection("one.location.permission_result.v2", 2)); });

  await waitFor(() => expect(h.capture).toHaveBeenCalledTimes(1));
  await screen.findByText(/Location setup complete/);
  expect(h.requestPermission).toHaveBeenCalledTimes(1);
  expect(h.save).toHaveBeenCalledTimes(1);
});

it("locking during native permission pauses the run and unlock never automatically resumes it", async () => {
  h.permission.mockResolvedValue({
    state: "prompt",
    locationServicesEnabled: true,
  });
  let allow!: (value: {
    state: string;
    locationServicesEnabled: boolean;
  }) => void;
  h.requestPermission.mockReturnValue(
    new Promise((resolve) => {
      allow = resolve;
    }),
  );
  const mounted = render(<App />);
  fireEvent.click(screen.getByText("Begin command"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Location setup: Continue" }),
  );
  await waitFor(() => expect(h.requestPermission).toHaveBeenCalledTimes(1));
  h.vault.isVaultUnlocked = false;
  mounted.rerender(<App />);
  await act(async () => {
    allow({ state: "granted", locationServicesEnabled: true });
  });
  h.vault.isVaultUnlocked = true;
  mounted.rerender(<App />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.capture).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  expect(
    h.settle.mock.calls.some(
      ([input]) => input.result === "permission_granted",
    ),
  ).toBe(false);
  expect(screen.queryByText(/Location setup complete/)).not.toBeInTheDocument();
});

it("an uncertain writer response offers explicit task recovery without automatically saving again", async () => {
  h.save.mockImplementation(async ({ beforeEffect }) => {
    await beforeEffect();
    throw new Error("synthetic lost response");
  });
  render(<App />);
  fireEvent.click(screen.getByText("Begin command"));
  await waitFor(
    () =>
      expect(
        screen.getByText(/save outcome could not be verified/),
      ).toBeInTheDocument(),
    { timeout: 4000 },
  );
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Refresh / Resume", exact: true })).toBeVisible();
  expect(window.location.pathname).toBe("/one/agents");
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.execute).not.toHaveBeenCalled();
  expect(screen.queryByText(/Location setup complete/)).not.toBeInTheDocument();
});
