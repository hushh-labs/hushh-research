import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

const USER = "u1";
const LOCATION_SCREEN = "one_location";

function appRuntimeState(screen: string): AppRuntimeState {
  return {
    auth: { signed_in: true, user_id: USER },
    vault: { unlocked: true, token_available: true, token_valid: true },
    route: {
      pathname: screen === LOCATION_SCREEN ? "/one/location" : "/one",
      screen,
    },
    runtime: {
      analysis_active: false,
      import_active: false,
      busy_operations: [],
    },
    portfolio: { has_portfolio_data: false },
    persona: { active: "investor", primary_nav: "investor", available: ["investor"] },
  } as unknown as AppRuntimeState;
}

const mocks = vi.hoisted(() => {
  // The runtime context the bridge mirrors into a ref on every render. A
  // navigation publishes a new snapshot, which re-renders subscribers the way
  // the real provider does when the route changes.
  const listeners = new Set<() => void>();
  const runtime = {
    snapshot: {
      screen: "one_home",
      executable: ["location.resume_updates", "location.pause_updates"] as string[] | null,
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (patch: Partial<{ screen: string; executable: string[] | null }>) => {
      runtime.snapshot = { ...runtime.snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
  return {
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() },
  runtime,
  mounted: false,
  executeAgentGatewayAction: vi.fn(),
  hasMountedLocalOnboardingHandler: vi.fn(),
  prepareLocalOnboardingAction: vi.fn(),
  waitForLocalOnboardingHandler: vi.fn(),
  requestInternalAppNavigation: vi.fn(),
  updateLocationAccountSettings: vi.fn(),
  setAnalysisParams: vi.fn(),
  busyOperations: {} as Record<string, boolean>,
  bus: { permission: "granted", status: "idle" },
  presentation: { ownerGrants: [] as Array<{ status: string }> } as { ownerGrants: Array<{ status: string }> } | null,
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: USER }) }));
vi.mock("@/lib/agent/agent-runtime-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAgentRuntimeStateOptional: () => {
      const snapshot = useSyncExternalStore(
        mocks.runtime.subscribe,
        () => mocks.runtime.snapshot,
        () => mocks.runtime.snapshot,
      );
      return {
        appRuntimeState: appRuntimeState(snapshot.screen),
        oneVoiceContextSnapshot: {
          executable_action_ids: snapshot.executable,
        },
      };
    },
  };
});
vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (selector: (state: unknown) => unknown) =>
    selector({
      busyOperations: mocks.busyOperations,
      setAnalysisParams: mocks.setAnalysisParams,
    }),
}));
vi.mock("@/lib/agent/agent-action-runtime", () => ({
  executeAgentGatewayAction: mocks.executeAgentGatewayAction,
}));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  hasMountedLocalOnboardingHandler: mocks.hasMountedLocalOnboardingHandler,
  prepareLocalOnboardingAction: mocks.prepareLocalOnboardingAction,
  waitForLocalOnboardingHandler: mocks.waitForLocalOnboardingHandler,
}));
vi.mock("@/lib/location/account-settings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/location/account-settings")>();
  return {
    ...actual,
    updateLocationAccountSettings: mocks.updateLocationAccountSettings,
  };
});
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: mocks.requestInternalAppNavigation,
}));
vi.mock("@/lib/one-location/location-bus", () => ({
  LocationBus: {
    getState: () => mocks.bus,
    subscribe: () => () => undefined,
    syncPermission: vi.fn(async () => "granted"),
    invalidate: vi.fn(),
  },
}));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: {
    readPresentation: () => mocks.presentation,
  },
}));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  };
});
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: () => ({}) },
  getApiBaseUrl: () => "http://localhost:8000",
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vot", vaultKey: "vk" }),
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { LocationUpdatesStepBridge } from "@/components/location/location-updates-step-bridge";
import { updateLocationAccountSettings } from "@/lib/location/account-settings";
import {
  forgetOneLocationControlPreference,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import {
  RESUME_UPDATES_ACTION_ID,
  PAUSE_UPDATES_ACTION_ID,
  resetLocationUpdatesStepState,
} from "@/lib/one-voice/location-updates-step";
import { localCloseReason } from "@/lib/one-voice/session-reducer";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import { readyFrame } from "@/__tests__/one-voice/fixtures/scripted-server";

type ExecuteInput = Parameters<
  typeof import("@/lib/agent/agent-action-runtime").executeAgentGatewayAction
>[0];

function succeeded(actionId: string): AgentActionRuntimeResult {
  return {
    status: "succeeded",
    actionId,
    label: null,
    routeBefore: "/one/location",
    resultSummary: "Location updates are on again for this device.",
  };
}

function resumeStep(stepId: string, timeoutS = 45) {
  return {
    stepId,
    kind: "set_location_updates",
    payload: {
      desired_state: "on",
      gateway_action_id: RESUME_UPDATES_ACTION_ID,
    },
    timeoutS,
  };
}

async function mountBridge() {
  const view = render(<LocationUpdatesStepBridge />);
  await waitFor(() =>
    expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
  );
  return view;
}

function emit(step: ReturnType<typeof resumeStep>) {
  const report = vi.fn();
  useVoiceSessionStore.getState().emitClientStep(step, report);
  return report;
}

/** Put the store into a live session so a `closed` event is a real ending. */
function connectStore() {
  const store = useVoiceSessionStore.getState();
  store.dispatch({ type: "connecting", conversationId: "11111111-2222-4333-8444-555555555555" });
  store.dispatch({
    type: "server",
    frame: readyFrame({ conversation_id: "11111111-2222-4333-8444-555555555555" }),
    now: Date.now(),
  });
  expect(useVoiceSessionStore.getState().state.phase).toBe("listening");
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLocationUpdatesStepState();
  forgetOneLocationControlPreference(USER);
  useVoiceSessionStore.getState().reset();
  useVoiceSessionStore.getState().effects.clear();
  mocks.runtime.set({
    screen: "one_home",
    executable: [RESUME_UPDATES_ACTION_ID, PAUSE_UPDATES_ACTION_ID],
  });
  mocks.mounted = false;
  mocks.presentation = { ownerGrants: [] };
  mocks.hasMountedLocalOnboardingHandler.mockImplementation(() => mocks.mounted);
  mocks.waitForLocalOnboardingHandler.mockImplementation(async () =>
    mocks.mounted ? (() => undefined) : null,
  );
  // Navigation is what mounts the Location page and moves the live route.
  mocks.requestInternalAppNavigation.mockImplementation(() => {
    mocks.mounted = true;
    mocks.runtime.set({ screen: LOCATION_SCREEN });
    return true;
  });
  mocks.prepareLocalOnboardingAction.mockResolvedValue({
    status: "ready",
    binding: { owner: USER, grants: [] },
    summary: "Enable Location on this device.",
  });
  mocks.executeAgentGatewayAction.mockImplementation(async (input: ExecuteInput) => {
    // The page's handler flips the control state; the step observes it.
    updateOneLocationControlState(USER, (current) => ({
      ...current,
      paused: false,
      selfPreviewEnabled: true,
    }));
    return succeeded(input.actionId);
  });
});

afterEach(() => {
  cleanup();
  useVoiceSessionStore.getState().effects.clear();
  forgetOneLocationControlPreference(USER);
});

describe("LocationUpdatesStepBridge", () => {
  it("claims only set_location_updates and leaves every other step kind untouched", async () => {
    await mountBridge();
    const report = emit({
      stepId: "s-other",
      kind: "publish_location_envelopes",
      payload: { grant_ids: ["g1"] },
      timeoutS: 30,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(report).not.toHaveBeenCalled();
    expect(mocks.requestInternalAppNavigation).not.toHaveBeenCalled();
    expect(mocks.executeAgentGatewayAction).not.toHaveBeenCalled();
  });

  it("navigates, prepares, executes through the gateway with the step id as the operation id, and reports exactly once", async () => {
    await mountBridge();
    const report = emit(resumeStep("step-1"));
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));

    expect(mocks.requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/location",
      source: "voice",
      transitionMode: "contextual",
    });
    expect(mocks.waitForLocalOnboardingHandler).toHaveBeenCalledWith(
      RESUME_UPDATES_ACTION_ID,
      8_000,
    );
    expect(mocks.prepareLocalOnboardingAction).toHaveBeenCalledWith(
      RESUME_UPDATES_ACTION_ID,
      {},
    );
    expect(mocks.executeAgentGatewayAction).toHaveBeenCalledTimes(1);
    const input = mocks.executeAgentGatewayAction.mock.calls[0]![0] as ExecuteInput;
    expect(input.actionId).toBe(RESUME_UPDATES_ACTION_ID);
    expect(input.userId).toBe(USER);
    expect(input.goalAuthorization).toEqual({
      goalId: "goal.location.resume_updates",
      expectedScreen: LOCATION_SCREEN,
    });
    expect(input.executionContext).toMatchObject({
      operationId: "step-1",
      directiveId: "step-1",
      preparedBinding: { owner: USER, grants: [] },
    });
    // The runtime snapshot is the one read at execution time (after the
    // navigation), never the /one render that received the frame.
    expect(input.appRuntimeState.route.screen).toBe(LOCATION_SCREEN);
    expect(input.allowedActionIds).toEqual([
      RESUME_UPDATES_ACTION_ID,
      PAUSE_UPDATES_ACTION_ID,
    ]);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.busyOperations).toBe(mocks.busyOperations);
    expect(input.setAnalysisParams).toBe(mocks.setAnalysisParams);

    expect(report).toHaveBeenCalledWith("ok", {
      gateway_action_id: RESUME_UPDATES_ACTION_ID,
      desired_state: "on",
      outcome: "on",
      observed_state: "on",
      reason_code: null,
      navigated: true,
      os_permission: "granted",
    });
    // Nothing on this path touches the account's sharing posture.
    expect(updateLocationAccountSettings).not.toHaveBeenCalled();
    expect(mocks.updateLocationAccountSettings).not.toHaveBeenCalled();

    // A second delivery of the same step id is ignored outright.
    const duplicate = emit(resumeStep("step-1"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(duplicate).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(mocks.executeAgentGatewayAction).toHaveBeenCalledTimes(1);
  });

  it("reports a refused payload as failed without navigating or touching settings", async () => {
    await mountBridge();
    const report = emit({
      stepId: "step-bad",
      kind: "set_location_updates",
      payload: { desired_state: "on", gateway_action_id: PAUSE_UPDATES_ACTION_ID },
      timeoutS: 45,
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        outcome: "failed",
        reason_code: "invalid_step_payload",
        navigated: false,
      }),
    );
    expect(mocks.requestInternalAppNavigation).not.toHaveBeenCalled();
    expect(mocks.executeAgentGatewayAction).not.toHaveBeenCalled();
    expect(mocks.updateLocationAccountSettings).not.toHaveBeenCalled();
  });

  it("blocks execution when the runtime is not ready, without touching settings", async () => {
    mocks.runtime.set({ executable: [] });
    await mountBridge();
    mocks.executeAgentGatewayAction.mockResolvedValue({
      status: "blocked",
      actionId: RESUME_UPDATES_ACTION_ID,
      label: null,
      routeBefore: "/one/location",
      resultSummary: "That control is not on this screen.",
      reason: "action_not_in_active_inventory",
    });
    const report = emit(resumeStep("step-inv"));
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(mocks.executeAgentGatewayAction.mock.calls[0]![0]).toMatchObject({
      allowedActionIds: [],
    });
    expect(report).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        outcome: "handler_unavailable",
        reason_code: "action_not_in_active_inventory",
      }),
    );
    expect(mocks.updateLocationAccountSettings).not.toHaveBeenCalled();
  });

  it("aborts in-flight work when the session ends, and reports cancelled", async () => {
    connectStore();
    await mountBridge();
    let abortedSignal: AbortSignal | null = null;
    mocks.executeAgentGatewayAction.mockImplementation(
      (input: ExecuteInput) =>
        new Promise<AgentActionRuntimeResult>((resolve) => {
          abortedSignal = input.signal ?? null;
          input.signal?.addEventListener("abort", () =>
            resolve({
              status: "blocked",
              actionId: input.actionId,
              label: null,
              routeBefore: "/one/location",
              resultSummary: "Cancelled.",
              reason: "execution_aborted",
            }),
          );
        }),
    );
    const report = emit(resumeStep("step-abort"));
    await waitFor(() =>
      expect(mocks.executeAgentGatewayAction).toHaveBeenCalledTimes(1),
    );
    expect(report).not.toHaveBeenCalled();
    expect(abortedSignal!.aborted).toBe(false);

    // The relay socket closed for good: phase goes idle.
    await act(async () => {
      useVoiceSessionStore.getState().dispatch({
        type: "closed",
        code: 1000,
        reason: localCloseReason("tap"),
        now: Date.now(),
      });
    });
    expect(useVoiceSessionStore.getState().state.phase).toBe("idle");
    expect(abortedSignal!.aborted).toBe(true);
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({ outcome: "cancelled", reason_code: "execution_aborted" }),
    );
    expect(mocks.updateLocationAccountSettings).not.toHaveBeenCalled();
  });

  it("does not abort a step just because a later step replaced the store's clientStep slot", async () => {
    connectStore();
    await mountBridge();
    const signals: AbortSignal[] = [];
    const settle = new Map<string, (result: AgentActionRuntimeResult) => void>();
    mocks.executeAgentGatewayAction.mockImplementation(
      (input: ExecuteInput) =>
        new Promise<AgentActionRuntimeResult>((resolve) => {
          signals.push(input.signal!);
          settle.set(String(input.executionContext?.operationId), resolve);
        }),
    );
    const first = emit(resumeStep("step-first"));
    await waitFor(() => expect(signals).toHaveLength(1));
    // A later, opposite-state request arrives while the first is executing.
    const second = emit({
      stepId: "step-second",
      kind: "set_location_updates",
      payload: { desired_state: "off", gateway_action_id: PAUSE_UPDATES_ACTION_ID },
      timeoutS: 45,
    });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(false);
    await act(async () => {
      updateOneLocationControlState(USER, (current) => ({ ...current, paused: true }));
      settle.get("step-first")!({
        status: "blocked",
        actionId: RESUME_UPDATES_ACTION_ID,
        label: null,
        routeBefore: "/one/location",
        resultSummary: "A newer location change replaced this one.",
        data: { reason: "superseded" },
      });
      settle.get("step-second")!(succeeded(PAUSE_UPDATES_ACTION_ID));
    });
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledWith("failed", expect.objectContaining({ outcome: "superseded" }));
    expect(second).toHaveBeenCalledWith("ok", expect.objectContaining({ outcome: "off", observed_state: "off" }));
  });
});
