import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import type { LocationBusStatus } from "@/lib/one-location/location-bus";
import type { OneLocationControlState } from "@/lib/one-location/location-control-state";
import {
  HANDLER_WAIT_MS,
  PAUSE_UPDATES_ACTION_ID,
  RESUME_UPDATES_ACTION_ID,
  classifyHandlerResult,
  decideIdempotent,
  observeLocationUpdates,
  parseLocationUpdatesStep,
  resetLocationUpdatesStepState,
  runLocationUpdatesStep,
  type LocationUpdatesExecuteInput,
  type LocationUpdatesStepPorts,
  type LocationUpdatesStepResult,
} from "@/lib/one-voice/location-updates-step";
import type { NavigationJourney } from "@/lib/voice/navigation-journey";

// Alias independence: the gateway is the only lexical surface on this path,
// and the step must keep working when every alias and keyword is gone. The
// flag is flipped inside the one test that proves it; every other test runs
// against the real catalog.
const gatewayMocks = vi.hoisted(() => ({
  stripAliases: false,
  searchKaiActions: vi.fn(),
  getKaiActionByVoiceToolCall: vi.fn(),
  getKaiActionByKaiCommand: vi.fn(),
}));

vi.mock("@/lib/voice/kai-action-gateway", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/voice/kai-action-gateway")>();
  const strip = <T extends { aliases: string[]; search_keywords: string[] }>(
    action: T,
  ): T =>
    gatewayMocks.stripAliases
      ? { ...action, aliases: [], search_keywords: [] }
      : action;
  gatewayMocks.searchKaiActions.mockImplementation(actual.searchKaiActions);
  gatewayMocks.getKaiActionByVoiceToolCall.mockImplementation(
    actual.getKaiActionByVoiceToolCall,
  );
  gatewayMocks.getKaiActionByKaiCommand.mockImplementation(
    actual.getKaiActionByKaiCommand,
  );
  return {
    ...actual,
    getKaiActionById: (actionId: string | null | undefined) => {
      const action = actual.getKaiActionById(actionId);
      return action ? strip(action) : null;
    },
    listKaiActions: () => actual.listKaiActions().map(strip),
    searchKaiActions: gatewayMocks.searchKaiActions,
    getKaiActionByVoiceToolCall: gatewayMocks.getKaiActionByVoiceToolCall,
    getKaiActionByKaiCommand: gatewayMocks.getKaiActionByKaiCommand,
  };
});

import {
  getKaiActionById,
  listKaiActions,
} from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";

const USER = "owner-1";
const LOCATION_SCREEN = "one_location";
const HOME_SCREEN = "one_home";

const REPORT_KEYS = [
  "desired_state",
  "gateway_action_id",
  "navigated",
  "observed_state",
  "os_permission",
  "outcome",
  "reason_code",
].sort();

function journeyFor(actionId: string): NavigationJourney {
  return {
    goalId: `goal.${actionId}`,
    destinationRoute: "/one/location",
    destinationScreen: LOCATION_SCREEN,
    navigationActionId: "route.one_location",
    label: actionId,
  };
}

function control(
  overrides: Partial<OneLocationControlState> = {},
): OneLocationControlState {
  return {
    autoApproveRequestsEnabled: false,
    autoApproveScope: null,
    autoApproveEnabledAt: null,
    paused: false,
    selfPreviewEnabled: false,
    nearbyPresenceActive: false,
    nearbyCheckedInAt: null,
    ...overrides,
  };
}

function runtimeResult(
  overrides: Partial<AgentActionRuntimeResult> = {},
): AgentActionRuntimeResult {
  return {
    status: "succeeded",
    actionId: RESUME_UPDATES_ACTION_ID,
    label: "Resume my location",
    routeBefore: "/one/location",
    resultSummary: "Location updates are on again for this device.",
    ...overrides,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A fake world for the ports: the app starts on /one with the handler
 * unmounted; `navigate` mounts the handler and moves the route, the way the
 * Location page's effect registration does after its paint.
 */
type World = {
  control: OneLocationControlState;
  ownerGrants: { status: string }[] | null;
  fixStatus: LocationBusStatus;
  route: string | null;
  mounted: boolean;
  preparation: LocalActionPreparation | null;
  executeResults: Array<
    AgentActionRuntimeResult | Promise<AgentActionRuntimeResult>
  >;
  executeCalls: LocationUpdatesExecuteInput[];
  executeRoutes: Array<string | null>;
  navigateCalls: string[];
  waitCalls: Array<{ actionId: string; timeoutMs: number }>;
  prepareCalls: string[];
  onExecute?: (input: LocationUpdatesExecuteInput) => void;
  onWaitForHandler?: () => void;
  ports: LocationUpdatesStepPorts;
};

function makeWorld(overrides: Partial<World> = {}): World {
  const world = {
    control: control(),
    ownerGrants: [] as { status: string }[] | null,
    fixStatus: "idle" as LocationBusStatus,
    route: HOME_SCREEN as string | null,
    mounted: false,
    preparation: {
      status: "ready",
      binding: { owner: USER, grants: [] },
      summary: "Enable Location on this device.",
    } as LocalActionPreparation | null,
    executeResults: [] as Array<
      AgentActionRuntimeResult | Promise<AgentActionRuntimeResult>
    >,
    executeCalls: [] as LocationUpdatesExecuteInput[],
    executeRoutes: [] as Array<string | null>,
    navigateCalls: [] as string[],
    waitCalls: [] as Array<{ actionId: string; timeoutMs: number }>,
    prepareCalls: [] as string[],
    ...overrides,
  } as World;
  world.ports = {
    userId: USER,
    readControlState: () => ({ ...world.control }),
    readOwnerGrants: () => world.ownerGrants,
    readFixStatus: () => world.fixStatus,
    readOsPermission: () => "granted",
    readRoute: () => world.route,
    isHandlerMounted: () => world.mounted,
    resolveJourney: (actionId) => journeyFor(actionId),
    navigate: (href) => {
      world.navigateCalls.push(href);
      world.mounted = true;
      world.route = LOCATION_SCREEN;
      return true;
    },
    waitForHandler: async (actionId, timeoutMs) => {
      world.waitCalls.push({ actionId, timeoutMs });
      world.onWaitForHandler?.();
      return world.mounted;
    },
    afterPaint: async () => undefined,
    prepare: async (actionId) => {
      world.prepareCalls.push(actionId);
      return world.preparation;
    },
    execute: async (input) => {
      world.executeCalls.push(input);
      world.executeRoutes.push(world.ports.readRoute());
      const next = world.executeResults.shift();
      if (world.onExecute) {
        world.onExecute(input);
      } else if (next === undefined) {
        // The default: the real handler's own optimistic update to the
        // control state, which is what the step observes afterwards.
        world.control =
          input.actionId === PAUSE_UPDATES_ACTION_ID
            ? control({ paused: true })
            : control({ selfPreviewEnabled: true });
      }
      return next ?? runtimeResult({ actionId: input.actionId });
    },
    now: () => Date.now(),
    sleep: async () => undefined,
    ...overrides.ports,
  };
  return world;
}

function onStep(stepId = "step-on", timeoutS: number | null = null) {
  return {
    stepId,
    payload: {
      desired_state: "on",
      gateway_action_id: RESUME_UPDATES_ACTION_ID,
    },
    timeoutS,
  };
}

function offStep(stepId = "step-off", timeoutS: number | null = null) {
  return {
    stepId,
    payload: {
      desired_state: "off",
      gateway_action_id: PAUSE_UPDATES_ACTION_ID,
    },
    timeoutS,
  };
}

function run(
  step: ReturnType<typeof onStep>,
  world: World,
  signal: AbortSignal = new AbortController().signal,
): Promise<LocationUpdatesStepResult> {
  return runLocationUpdatesStep(step, world.ports, signal);
}

beforeEach(() => {
  resetLocationUpdatesStepState();
  gatewayMocks.stripAliases = false;
  gatewayMocks.searchKaiActions.mockClear();
  gatewayMocks.getKaiActionByVoiceToolCall.mockClear();
  gatewayMocks.getKaiActionByKaiCommand.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLocationUpdatesStep", () => {
  it("accepts exactly the two authored (state, action) pairs", () => {
    expect(
      parseLocationUpdatesStep({
        desired_state: "on",
        gateway_action_id: RESUME_UPDATES_ACTION_ID,
      }),
    ).toEqual({ desiredState: "on", actionId: RESUME_UPDATES_ACTION_ID });
    expect(
      parseLocationUpdatesStep({
        desired_state: "off",
        gateway_action_id: PAUSE_UPDATES_ACTION_ID,
      }),
    ).toEqual({ desiredState: "off", actionId: PAUSE_UPDATES_ACTION_ID });
  });

  it.each([
    [
      "mismatched gateway id",
      { desired_state: "on", gateway_action_id: PAUSE_UPDATES_ACTION_ID },
    ],
    [
      "unknown desired_state",
      { desired_state: "toggle", gateway_action_id: RESUME_UPDATES_ACTION_ID },
    ],
    [
      "foreign action id",
      { desired_state: "off", gateway_action_id: "location.set_sharing_enabled" },
    ],
    ["empty payload", {}],
    ["null payload", null],
  ])("refuses %s", (_label, payload) => {
    expect(parseLocationUpdatesStep(payload as Record<string, unknown>)).toBeNull();
  });
});

describe("runLocationUpdatesStep: payload validation", () => {
  it.each([
    [
      "mismatched gateway id",
      { desired_state: "on", gateway_action_id: PAUSE_UPDATES_ACTION_ID },
    ],
    [
      "unknown desired_state",
      { desired_state: "toggle", gateway_action_id: RESUME_UPDATES_ACTION_ID },
    ],
  ])(
    "reports failed/invalid_step_payload for %s without navigating",
    async (_label, payload) => {
      const world = makeWorld();
      const result = await run(
        { stepId: "bad", payload, timeoutS: 30 },
        world,
      );
      expect(result.status).toBe("failed");
      expect(result.payload.outcome).toBe("failed");
      expect(result.payload.reason_code).toBe("invalid_step_payload");
      expect(result.payload.navigated).toBe(false);
      expect(world.navigateCalls).toEqual([]);
      expect(world.prepareCalls).toEqual([]);
      expect(world.executeCalls).toEqual([]);
    },
  );

  it("reports signed_out with no user and never navigates", async () => {
    const world = makeWorld();
    world.ports.userId = null;
    const result = await run(onStep(), world);
    expect(result).toMatchObject({
      status: "failed",
      payload: { outcome: "signed_out", reason_code: "signed_out", navigated: false },
    });
    expect(world.navigateCalls).toEqual([]);
    expect(world.executeCalls).toEqual([]);
  });

  it("reports handler_unavailable when the action has no authored journey", async () => {
    const world = makeWorld();
    world.ports.resolveJourney = () => null;
    const result = await run(onStep(), world);
    expect(result.payload).toMatchObject({
      outcome: "handler_unavailable",
      reason_code: "journey_unresolved",
      navigated: false,
    });
    expect(world.navigateCalls).toEqual([]);
  });
});

describe("decideIdempotent", () => {
  const cases: Array<{
    desired: "on" | "off";
    control: Partial<OneLocationControlState>;
    fix: LocationBusStatus;
    expected: "already_on" | "already_off" | null;
  }> = [
    { desired: "off", control: { paused: true }, fix: "idle", expected: "already_off" },
    { desired: "off", control: { paused: true, selfPreviewEnabled: true }, fix: "ready", expected: "already_off" },
    { desired: "off", control: { paused: false }, fix: "ready", expected: null },
    { desired: "off", control: { paused: false, selfPreviewEnabled: true }, fix: "ready", expected: null },
    { desired: "on", control: { paused: false, selfPreviewEnabled: true }, fix: "ready", expected: "already_on" },
    { desired: "on", control: { paused: true, selfPreviewEnabled: true }, fix: "ready", expected: null },
    { desired: "on", control: { paused: false, selfPreviewEnabled: false }, fix: "ready", expected: null },
    { desired: "on", control: { paused: false, selfPreviewEnabled: true }, fix: "stale", expected: null },
    { desired: "on", control: { paused: false, selfPreviewEnabled: true }, fix: "blocked", expected: null },
    { desired: "on", control: { paused: false, selfPreviewEnabled: true }, fix: "idle", expected: null },
    { desired: "on", control: { paused: false, selfPreviewEnabled: true }, fix: "locating", expected: null },
    { desired: "on", control: { paused: false, nearbyPresenceActive: true }, fix: "ready", expected: null },
  ];

  it.each(cases)(
    "desired=$desired control=$control fix=$fix -> $expected",
    ({ desired, control: patch, fix, expected }) => {
      expect(decideIdempotent(desired, control(patch), fix)).toBe(expected);
    },
  );

  it("already_off answers from the persisted pause without navigating or executing", async () => {
    const world = makeWorld({ control: control({ paused: true }) });
    const result = await run(offStep(), world);
    expect(result).toMatchObject({
      status: "ok",
      payload: {
        outcome: "already_off",
        observed_state: "off",
        navigated: false,
        reason_code: null,
      },
    });
    expect(world.navigateCalls).toEqual([]);
    expect(world.executeCalls).toEqual([]);
  });

  it("already_on needs the self preview and a fix measured this session", async () => {
    const world = makeWorld({
      control: control({ selfPreviewEnabled: true }),
      fixStatus: "ready",
    });
    const result = await run(onStep(), world);
    expect(result).toMatchObject({
      status: "ok",
      payload: { outcome: "already_on", observed_state: "on", navigated: false },
    });
    expect(world.executeCalls).toEqual([]);
  });

  it("a stale fix runs the real handler instead of answering already_on", async () => {
    const world = makeWorld({
      control: control({ selfPreviewEnabled: true }),
      fixStatus: "stale",
    });
    const result = await run(onStep(), world);
    expect(result.payload.outcome).toBe("on");
    expect(world.executeCalls).toHaveLength(1);
  });

  it("a blocked device is never already_on", async () => {
    const world = makeWorld({
      control: control({ selfPreviewEnabled: true }),
      fixStatus: "blocked",
      executeResults: [
        runtimeResult({
          status: "blocked",
          resultSummary: "Needs device Location permission.",
          data: { reason: "permission_denied" },
        }),
      ],
    });
    const result = await run(onStep(), world);
    expect(result.payload.outcome).toBe("permission_denied");
    expect(world.executeCalls).toHaveLength(1);
  });
});

describe("observeLocationUpdates", () => {
  it("reads the switch's own derivation, with unloaded grants counting as none", () => {
    expect(
      observeLocationUpdates({
        readControlState: () => control({ selfPreviewEnabled: true }),
        readOwnerGrants: () => null,
      }),
    ).toBe("on");
    expect(
      observeLocationUpdates({
        readControlState: () => control(),
        readOwnerGrants: () => [{ status: "active" }],
      }),
    ).toBe("on");
    expect(
      observeLocationUpdates({
        readControlState: () => control({ paused: true }),
        readOwnerGrants: () => [{ status: "active" }],
      }),
    ).toBe("off");
    expect(
      observeLocationUpdates({
        readControlState: () => control(),
        readOwnerGrants: () => [{ status: "expired" }],
      }),
    ).toBe("off");
  });
});

describe("runLocationUpdatesStep: navigation and mounting", () => {
  it("navigates only when the handler is not mounted, then waits with the bounded budget", async () => {
    const world = makeWorld();
    const result = await run(onStep(), world);
    expect(world.navigateCalls).toEqual(["/one/location"]);
    expect(world.waitCalls).toEqual([
      { actionId: RESUME_UPDATES_ACTION_ID, timeoutMs: HANDLER_WAIT_MS },
    ]);
    expect(world.waitCalls[0]?.timeoutMs).toBe(8000);
    expect(result.payload.navigated).toBe(true);
    expect(result.payload.outcome).toBe("on");
  });

  it("does not navigate when the handler is already mounted on the destination", async () => {
    const world = makeWorld({ mounted: true, route: LOCATION_SCREEN });
    const result = await run(onStep(), world);
    expect(world.navigateCalls).toEqual([]);
    expect(world.waitCalls).toHaveLength(1);
    expect(result.payload.navigated).toBe(false);
    expect(result.payload.outcome).toBe("on");
  });

  it("reports handler_unavailable (navigated:true) when the handler never mounts", async () => {
    const world = makeWorld();
    world.ports.navigate = (href) => {
      world.navigateCalls.push(href);
      return true;
    };
    const result = await run(onStep(), world);
    expect(result).toMatchObject({
      status: "failed",
      payload: {
        outcome: "handler_unavailable",
        reason_code: "local_handler_not_mounted",
        navigated: true,
      },
    });
    expect(world.prepareCalls).toEqual([]);
    expect(world.executeCalls).toEqual([]);
  });

  it("reports handler_unavailable when navigation is refused", async () => {
    const world = makeWorld();
    world.ports.navigate = () => false;
    const result = await run(onStep(), world);
    expect(result.payload).toMatchObject({
      outcome: "handler_unavailable",
      reason_code: "navigation_unavailable",
      navigated: true,
    });
    expect(world.waitCalls).toEqual([]);
  });

  it("reports handler_unavailable when the handler mounts but the route is not the destination", async () => {
    const world = makeWorld();
    world.ports.navigate = (href) => {
      world.navigateCalls.push(href);
      world.mounted = true;
      world.route = HOME_SCREEN;
      return true;
    };
    const result = await run(onStep(), world);
    expect(result.payload).toMatchObject({
      outcome: "handler_unavailable",
      reason_code: "local_handler_not_mounted",
      navigated: true,
    });
    expect(world.executeCalls).toEqual([]);
  });

  it("executes only once the live route reads the destination screen, not the step-start route", async () => {
    const world = makeWorld();
    const routesSeen: Array<string | null> = [];
    routesSeen.push(world.ports.readRoute());
    const result = await run(onStep(), world);
    expect(routesSeen).toEqual([HOME_SCREEN]);
    expect(world.executeRoutes).toEqual([LOCATION_SCREEN]);
    expect(result.payload.outcome).toBe("on");
  });
});

describe("runLocationUpdatesStep: prepare and execute", () => {
  it("passes the step id as the operation id, the prepared binding, and the journey's goal", async () => {
    const world = makeWorld({
      preparation: {
        status: "ready",
        binding: { owner: USER, grants: ["g-1", "g-2"] },
        summary: "Enable Location on this device.",
      },
    });
    await run(onStep("step-42"), world);
    expect(world.prepareCalls).toEqual([RESUME_UPDATES_ACTION_ID]);
    expect(world.executeCalls).toHaveLength(1);
    const input = world.executeCalls[0]!;
    expect(input.operationId).toBe("step-42");
    expect(input.actionId).toBe(RESUME_UPDATES_ACTION_ID);
    expect(input.preparedBinding).toEqual({ owner: USER, grants: ["g-1", "g-2"] });
    expect(input.goalId).toBe(`goal.${RESUME_UPDATES_ACTION_ID}`);
    expect(input.expectedScreen).toBe(LOCATION_SCREEN);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("never executes for a binding owned by someone else", async () => {
    const world = makeWorld({
      preparation: {
        status: "ready",
        binding: { owner: "someone-else" },
        summary: "Enable Location on this device.",
      },
    });
    const result = await run(onStep(), world);
    expect(result).toMatchObject({
      status: "failed",
      payload: { outcome: "failed", reason_code: "owner_mismatch" },
    });
    expect(world.executeCalls).toEqual([]);
  });

  it.each([
    [
      "blocked",
      {
        status: "blocked",
        summary: "Unlock One first.",
        gate: "input",
      } satisfies LocalActionPreparation,
    ],
    ["simulate", { status: "simulate", summary: "Not on this platform." } satisfies LocalActionPreparation],
    ["absent", null],
  ])("never executes when preparation is %s", async (_label, preparation) => {
    const world = makeWorld({ preparation });
    const result = await run(onStep(), world);
    expect(result.payload).toMatchObject({
      outcome: "handler_unavailable",
      reason_code: "not_ready",
    });
    expect(world.executeCalls).toEqual([]);
  });

  it("waits a bounded moment for the owner's grants to load before preparing", async () => {
    const world = makeWorld({ ownerGrants: null });
    let reads = 0;
    world.ports.readOwnerGrants = () => {
      reads += 1;
      return reads > 3 ? [] : null;
    };
    const sleeps: number[] = [];
    world.ports.sleep = async (ms) => {
      sleeps.push(ms);
    };
    const result = await run(onStep(), world);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(world.prepareCalls).toEqual([RESUME_UPDATES_ACTION_ID]);
    expect(result.payload.outcome).toBe("on");
  });
});

describe("classifyHandlerResult", () => {
  it("maps success against the observed state", () => {
    expect(classifyHandlerResult(runtimeResult(), "on", "on")).toEqual({
      outcome: "on",
      reasonCode: null,
    });
    expect(classifyHandlerResult(runtimeResult(), "off", "off")).toEqual({
      outcome: "off",
      reasonCode: null,
    });
    expect(classifyHandlerResult(runtimeResult(), "on", "off")).toEqual({
      outcome: "superseded",
      reasonCode: "state_moved_on",
    });
  });

  it.each([
    "permission_denied",
    "no_fix",
    "superseded",
    "vault_locked",
    "nearby_checkout_failed",
    "signed_out",
  ] as const)("carries the handler's typed reason %s through as the outcome", (reason) => {
    expect(
      classifyHandlerResult(
        runtimeResult({ status: "blocked", data: { reason } }),
        "on",
        "off",
      ),
    ).toEqual({ outcome: reason, reasonCode: reason });
  });

  it.each([
    ["local_handler_not_mounted", "handler_unavailable"],
    ["action_not_in_active_inventory", "handler_unavailable"],
    ["execution_aborted", "cancelled"],
  ] as const)("maps the dispatcher reason %s to %s", (reason, outcome) => {
    expect(
      classifyHandlerResult(
        runtimeResult({ status: "blocked", reason }),
        "on",
        "off",
      ),
    ).toEqual({ outcome, reasonCode: reason });
  });

  it("falls back to failed with the status as the reason code", () => {
    expect(
      classifyHandlerResult(
        runtimeResult({ status: "failed", resultSummary: "Something else." }),
        "on",
        "off",
      ),
    ).toEqual({ outcome: "failed", reasonCode: "failed" });
  });
});

describe("runLocationUpdatesStep: result mapping", () => {
  it("reports on when the handler succeeded and the switch reads on", async () => {
    const world = makeWorld();
    world.onExecute = () => {
      world.control = control({ selfPreviewEnabled: true });
    };
    const result = await run(onStep(), world);
    expect(result).toEqual({
      status: "ok",
      payload: {
        gateway_action_id: RESUME_UPDATES_ACTION_ID,
        desired_state: "on",
        outcome: "on",
        observed_state: "on",
        reason_code: null,
        navigated: true,
        os_permission: "granted",
      },
    });
  });

  it("reports off when the pause handler succeeded and the switch reads off", async () => {
    const world = makeWorld({
      control: control({ selfPreviewEnabled: true }),
      mounted: true,
      route: LOCATION_SCREEN,
      executeResults: [
        runtimeResult({
          actionId: PAUSE_UPDATES_ACTION_ID,
          resultSummary: "Location updates are paused on this device.",
        }),
      ],
    });
    world.onExecute = () => {
      world.control = control({ paused: true });
    };
    const result = await run(offStep(), world);
    expect(result).toMatchObject({
      status: "ok",
      payload: { outcome: "off", observed_state: "off", navigated: false },
    });
  });

  it("reports superseded when the handler succeeded but the switch reads the other way", async () => {
    const world = makeWorld();
    // A newer pause landed after this resume: the control state is paused.
    world.onExecute = () => {
      world.control = control({ paused: true });
    };
    const result = await run(onStep(), world);
    expect(result).toMatchObject({
      status: "failed",
      payload: {
        outcome: "superseded",
        reason_code: "state_moved_on",
        observed_state: "off",
      },
    });
  });

  it.each([
    "permission_denied",
    "no_fix",
    "superseded",
    "vault_locked",
    "nearby_checkout_failed",
    "signed_out",
  ] as const)("reports the handler's data.reason %s with the observed state", async (reason) => {
    const world = makeWorld({
      executeResults: [
        runtimeResult({
          status: "blocked",
          resultSummary: "Some sentence the step never compares.",
          data: { reason },
        }),
      ],
    });
    const result = await run(onStep(), world);
    expect(result).toMatchObject({
      status: "failed",
      payload: { outcome: reason, reason_code: reason, observed_state: "off" },
    });
  });

  it("reports handler_unavailable for local_handler_not_mounted and cancelled for execution_aborted", async () => {
    const unmounted = makeWorld({
      executeResults: [
        runtimeResult({
          status: "blocked",
          reason: "local_handler_not_mounted",
          resultSummary: "Open Location first.",
        }),
      ],
    });
    expect((await run(onStep(), unmounted)).payload).toMatchObject({
      outcome: "handler_unavailable",
      reason_code: "local_handler_not_mounted",
    });

    const aborted = makeWorld({
      executeResults: [
        runtimeResult({
          status: "blocked",
          reason: "execution_aborted",
          resultSummary: "Cancelled.",
        }),
      ],
    });
    expect((await run(onStep(), aborted)).payload).toMatchObject({
      outcome: "cancelled",
      reason_code: "execution_aborted",
    });
  });

  it("re-prepares once when the binding changed, then reports handler_unavailable", async () => {
    const changed = runtimeResult({
      status: "blocked",
      resultSummary: "The selected information changed. Review the action again.",
    });
    const world = makeWorld({ executeResults: [changed, changed] });
    const result = await run(onStep(), world);
    expect(world.prepareCalls).toEqual([
      RESUME_UPDATES_ACTION_ID,
      RESUME_UPDATES_ACTION_ID,
    ]);
    expect(world.executeCalls).toHaveLength(2);
    expect(result).toMatchObject({
      status: "failed",
      payload: { outcome: "handler_unavailable", reason_code: "binding_changed" },
    });
  });

  it("a single binding change is recovered by the one retry", async () => {
    const world = makeWorld({
      executeResults: [
        runtimeResult({
          status: "blocked",
          resultSummary: "The selected information changed. Review the action again.",
        }),
      ],
    });
    world.onExecute = () => {
      if (world.executeCalls.length === 2)
        world.control = control({ selfPreviewEnabled: true });
    };
    const result = await run(onStep(), world);
    expect(world.executeCalls).toHaveLength(2);
    expect(result.payload.outcome).toBe("on");
  });

  it("carries only the typed report keys: never a summary, binding, grant id, or coordinate", async () => {
    const world = makeWorld({
      preparation: {
        status: "ready",
        binding: { owner: USER, grants: ["grant-secret"] },
        summary: "Enable Location on this device. 1 existing shares may receive updates.",
      },
      executeResults: [
        runtimeResult({
          data: {
            reason: "no_fix",
            latitude: 28.6139,
            longitude: 77.209,
            grants: ["grant-secret"],
          },
          status: "blocked",
        }),
      ],
    });
    const result = await run(onStep(), world);
    expect(Object.keys(result.payload).sort()).toEqual(REPORT_KEYS);
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain("grant-secret");
    expect(serialized).not.toContain("28.6139");
    expect(serialized).not.toContain("existing shares");
  });
});

describe("runLocationUpdatesStep: cancellation, coalescing, ordering, deadline", () => {
  it("reports cancelled when aborted before execute and never executes", async () => {
    const controller = new AbortController();
    const world = makeWorld();
    world.onWaitForHandler = () => controller.abort();
    const result = await run(onStep(), world, controller.signal);
    expect(result).toMatchObject({
      status: "failed",
      payload: { outcome: "cancelled", reason_code: "execution_aborted" },
    });
    expect(world.executeCalls).toEqual([]);
  });

  it("reports cancelled when the signal is already aborted, without navigating", async () => {
    const controller = new AbortController();
    controller.abort();
    const world = makeWorld();
    const result = await run(onStep(), world, controller.signal);
    expect(result.payload).toMatchObject({ outcome: "cancelled", navigated: false });
    expect(world.navigateCalls).toEqual([]);
  });

  it("coalesces two overlapping same-state steps onto one handler run", async () => {
    const pending = deferred<AgentActionRuntimeResult>();
    const world = makeWorld({ executeResults: [pending.promise] });
    world.onExecute = () => {
      world.control = control({ selfPreviewEnabled: true });
    };
    const first = run(onStep("step-a"), world);
    const second = run(onStep("step-b"), world);
    await Promise.resolve();
    pending.resolve(runtimeResult());
    const [a, b] = await Promise.all([first, second]);
    expect(world.executeCalls).toHaveLength(1);
    expect(a).toMatchObject({ status: "ok", payload: { outcome: "on" } });
    expect(b).toMatchObject({ status: "ok", payload: { outcome: "on" } });
    expect(world.executeCalls[0]?.operationId).toBe("step-a");
  });

  it("runs a new same-state step once the earlier one has settled", async () => {
    const world = makeWorld();
    await run(onStep("step-a"), world);
    await run(onStep("step-b"), world);
    expect(world.executeCalls.map((call) => call.operationId)).toEqual([
      "step-a",
      "step-b",
    ]);
  });

  it("runs opposite-state steps in arrival order without coalescing", async () => {
    const onPending = deferred<AgentActionRuntimeResult>();
    const offPending = deferred<AgentActionRuntimeResult>();
    const world = makeWorld({
      executeResults: [onPending.promise, offPending.promise],
    });
    const first = run(onStep("step-on"), world);
    const second = run(offStep("step-off"), world);
    await vi.waitFor(() => expect(world.executeCalls).toHaveLength(2));
    expect(world.executeCalls.map((call) => call.actionId)).toEqual([
      RESUME_UPDATES_ACTION_ID,
      PAUSE_UPDATES_ACTION_ID,
    ]);
    expect(world.executeCalls.map((call) => call.operationId)).toEqual([
      "step-on",
      "step-off",
    ]);
    world.control = control({ paused: true });
    onPending.resolve(
      runtimeResult({ status: "blocked", data: { reason: "superseded" } }),
    );
    offPending.resolve(runtimeResult({ actionId: PAUSE_UPDATES_ACTION_ID }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.payload.outcome).toBe("superseded");
    expect(b.payload.outcome).toBe("off");
  });

  it("reports timed_out one second before the provider's budget while execute is still pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const never = deferred<AgentActionRuntimeResult>();
    const world = makeWorld({ executeResults: [never.promise] });
    const timeoutS = 30;
    let settled: LocationUpdatesStepResult | null = null;
    const running = run(onStep("step-slow", timeoutS), world).then((result) => {
      settled = result;
      return result;
    });
    await vi.advanceTimersByTimeAsync(timeoutS * 1000 - 1000 - 1);
    expect(world.executeCalls).toHaveLength(1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(result).toMatchObject({
      status: "failed",
      payload: {
        outcome: "timed_out",
        reason_code: "timed_out",
        observed_state: "off",
        navigated: true,
      },
    });
    expect(Date.now() - 1_700_000_000_000).toBe(timeoutS * 1000 - 1000);
  });

  it("has no self deadline when the server sent no budget", async () => {
    vi.useFakeTimers();
    const pending = deferred<AgentActionRuntimeResult>();
    const world = makeWorld({ executeResults: [pending.promise] });
    let settled = false;
    const running = run(onStep("step-open", null), world).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    world.control = control({ selfPreviewEnabled: true });
    pending.resolve(runtimeResult());
    expect((await running).payload.outcome).toBe("on");
  });
});

describe("alias independence", () => {
  it("resolves the journey and runs the step with every alias and keyword stripped from the gateway", async () => {
    gatewayMocks.stripAliases = true;
    for (const actionId of [RESUME_UPDATES_ACTION_ID, PAUSE_UPDATES_ACTION_ID]) {
      const action = getKaiActionById(actionId);
      expect(action?.action_id).toBe(actionId);
      expect(action?.aliases).toEqual([]);
      expect(action?.search_keywords).toEqual([]);
    }
    expect(listKaiActions().every((action) => action.aliases.length === 0)).toBe(true);

    const resume = resolveNavigationJourney(RESUME_UPDATES_ACTION_ID);
    const pause = resolveNavigationJourney(PAUSE_UPDATES_ACTION_ID);
    expect(resume).toMatchObject({
      goalId: "goal.location.resume_updates",
      destinationRoute: "/one/location",
      destinationScreen: LOCATION_SCREEN,
    });
    expect(pause).toMatchObject({
      goalId: "goal.location.pause_updates",
      destinationRoute: "/one/location",
      destinationScreen: LOCATION_SCREEN,
    });

    const world = makeWorld();
    world.ports.resolveJourney = (actionId) => resolveNavigationJourney(actionId);
    world.onExecute = () => {
      world.control = control({ selfPreviewEnabled: true });
    };
    const result = await run(onStep(), world);
    expect(world.navigateCalls).toEqual(["/one/location"]);
    expect(world.prepareCalls).toEqual([RESUME_UPDATES_ACTION_ID]);
    expect(world.executeCalls).toHaveLength(1);
    expect(world.executeCalls[0]).toMatchObject({
      goalId: "goal.location.resume_updates",
      expectedScreen: LOCATION_SCREEN,
    });
    expect(result.payload.outcome).toBe("on");

    // Only exact-id lookups happened: no search, no alias or command matcher.
    expect(gatewayMocks.searchKaiActions).not.toHaveBeenCalled();
    expect(gatewayMocks.getKaiActionByVoiceToolCall).not.toHaveBeenCalled();
    expect(gatewayMocks.getKaiActionByKaiCommand).not.toHaveBeenCalled();
  });

  it("imports no retrieval, search, or alias helper into the step module", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../lib/one-voice/location-updates-step.ts"),
      "utf8",
    );
    const specifiers = Array.from(
      source.matchAll(/from\s+"([^"]+)"/g),
      (match) => match[1]!,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/action-retrieval|retrieval|search|alias|synonym/i);
    }
    // The only voice-gateway import is the journey TYPE; the lookup itself is
    // a port supplied by the bridge.
    expect(specifiers.filter((s) => s.startsWith("@/lib/voice/"))).toEqual([
      "@/lib/voice/navigation-journey",
    ]);
    expect(source).toMatch(
      /import type \{ NavigationJourney \} from "@\/lib\/voice\/navigation-journey"/,
    );
    expect(source).not.toContain("kai-action-gateway");
    expect(source).not.toMatch(/searchKaiActions|searchActions|aliases|search_keywords/);
  });
});
