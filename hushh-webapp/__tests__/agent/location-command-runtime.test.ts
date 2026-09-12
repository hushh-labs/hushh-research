// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { decryptData, encryptData } from "@/lib/vault/encrypt";
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  prepare: vi.fn(),
  action: vi.fn(),
  permission: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));
vi.mock("@/lib/voice/kai-action-gateway", () => ({
  getKaiActionById: mocks.action,
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getPermissionState: mocks.permission,
    requestLocationPermission: mocks.requestPermission,
  },
}));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  prepareLocalOnboardingAction: mocks.prepare,
  canonicalActionBinding: JSON.stringify,
}));
import {
  LocationCommandRuntime,
  type CommandPorts,
  type CommandPresentation,
} from "@/lib/agent/location-command-runtime";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  mocks.permission.mockResolvedValue({ state: "granted" });
});

function fixture(
  options: {
    confirmation?: boolean;
    uncertain?: boolean;
    permission?: boolean;
    screen?: boolean;
  } = {},
) {
  const plan = {
    schema_version: "location.plan.v1",
    capability_revision: "cap",
    context_revision: "ctx",
    mode: "end_to_end",
    steps: [{ action_id: "location.test", slots: {} }],
    gate: null,
  };
  let checkpoint: any = {
    command_id: "cmd",
    revision: 1,
    next_step: 0,
    step_count: 1,
    status: "awaiting_checkpoint",
    capsule: null,
  };
  let issued = false;
  const calls: Array<{ path: string; body: any }> = [];
  mocks.action.mockReturnValue({
    action_id: "location.test",
    label: "Location action",
    meaning: "Do the action",
    execution_target: { status: "wired", path: "local_handler" },
    command: {
      review_route: "/one/location",
      ...(options.permission ? { permission: "location" } : {}),
    },
  });
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding: { target: "Alice" },
    summary: "Confirm Alice",
  });
  mocks.apiFetch.mockImplementation(async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    let response;
    if (path.endsWith("agent-chat/proposals")) response = { plan, checkpoint };
    else if (path.endsWith("/checkpoint")) {
      checkpoint = {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        status: "ready",
        capsule: body.capsule,
      };
      response = { checkpoint };
    } else if (path.endsWith("/admit") || path.endsWith("/resume")) {
      issued = true;
      response = options.uncertain
        ? { status: "reconcile", review_route: "/one/location" }
        : {
            status: options.confirmation ? "needs_confirmation" : "ready",
            directive: {
              directive_id: "dir",
              operation_id: "op",
              context_revision: "ctx",
            },
          };
    } else if (path.endsWith("/confirm"))
      response = { receipt: "human-receipt" };
    else if (path.endsWith("/claim")) {
      expect(issued).toBe(true);
      response = {
        directive_id: "dir",
        operation_id: "op",
        execution_receipt: "execution-receipt",
        effect: options.screen ? "screen" : "action",
        route: "/one/location?action=share",
      };
    } else if (path.endsWith("/settle")) {
      checkpoint = {
        ...checkpoint,
        next_step: 1,
        status: body.status === "succeeded" ? "completed" : "review_required",
        capsule: null,
      };
      response = { checkpoint };
    } else if (path.endsWith("/action-proposals/cmd"))
      response = { checkpoint };
    else response = { commands: [checkpoint] };
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const views: CommandPresentation[] = [];
  const ports: CommandPorts = {
    authority: () => ({
      userId: "owner",
      token: "owner-token",
      vaultKey: "12".repeat(32),
    }),
    context: () => ({}),
    present: (value) => views.push(value),
    navigate: vi.fn().mockResolvedValue(true),
    execute: vi
      .fn()
      .mockResolvedValue({
        status: "succeeded",
        resultSummary: "Acknowledged by Location.",
      }),
  };
  return {
    runtime: new LocationCommandRuntime(ports),
    ports,
    views,
    calls,
    checkpoint: () => checkpoint,
  };
}

it("checkpoints owner encryption before effects and excludes raw transcript", async () => {
  const f = fixture();
  await f.runtime.submit("private raw words");
  const checkpoint = f.calls.find((call) => call.path.endsWith("/checkpoint"))!;
  const decrypted = await decryptData(checkpoint.body.capsule, "12".repeat(32));
  expect(decrypted).not.toContain("private raw words");
  expect(JSON.parse(decrypted).owner).toBe("owner");
  expect(
    f.calls.findIndex((call) => call.path.endsWith("/checkpoint")),
  ).toBeLessThan(f.calls.findIndex((call) => call.path.endsWith("/claim")));
  expect(f.ports.execute).toHaveBeenCalledTimes(1);
  expect(f.views.at(-1)?.message).toBe("Acknowledged by Location.");
  expect(f.calls.every((call) => !/adk|live|audio/i.test(call.path))).toBe(
    true,
  );
});

it("requires a real confirmation gesture and rejects changed recipients", async () => {
  const f = fixture({ confirmation: true });
  await f.runtime.submit("stop sharing");
  expect(f.views.at(-1)?.message).toBe("Confirm Alice");
  await f.runtime.continueGate(false);
  expect(f.ports.execute).not.toHaveBeenCalled();
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding: { target: "Bob" },
    summary: "Confirm Bob",
  });
  await expect(f.runtime.continueGate(true)).rejects.toThrow("changed");
  expect(f.ports.execute).not.toHaveBeenCalled();
});

it("permission prompt continues the same command without another transcription", async () => {
  const f = fixture({ permission: true });
  mocks.permission.mockResolvedValue({ state: "prompt" });
  mocks.requestPermission.mockResolvedValue({ state: "granted" });
  await f.runtime.submit("enable location");
  expect(f.views.at(-1)?.gate?.kind).toBe("permission");
  expect(f.ports.execute).not.toHaveBeenCalled();
  await f.runtime.continueGate(true);
  expect(f.ports.execute).toHaveBeenCalledTimes(1);
  expect(
    f.calls.filter((call) => call.path.endsWith("agent-chat/proposals")),
  ).toHaveLength(1);
});

it("explicit resume reconciles uncertain effects without repeating them", async () => {
  const f = fixture({ uncertain: true });
  await f.runtime.submit("create circle");
  expect(f.ports.execute).not.toHaveBeenCalled();
  f.runtime.pause();
  await f.runtime.recover();
  expect(f.ports.execute).not.toHaveBeenCalled();
  await f.runtime.resume(f.checkpoint());
  expect(f.calls.some((call) => call.path.endsWith("/resume"))).toBe(true);
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(f.views.at(-1)?.message).toContain("may already");
});

it("keeps coordinates, message and binding salt off every authority request", async () => {
  const f = fixture({ confirmation: true });
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding: {
      point: { latitude: 19.876543, longitude: 73.123456 },
      message: "private check-in note",
    },
    summary: "Review check-in",
  });
  await f.runtime.submit("check in");
  const bodies = JSON.stringify(f.calls.map((call) => call.body));
  expect(bodies).not.toContain("19.876543");
  expect(bodies).not.toContain("73.123456");
  expect(bodies).not.toContain("private check-in note");
  const saved = f.calls
    .filter((call) => call.path.endsWith("/checkpoint"))
    .at(-1)!;
  const capsule = JSON.parse(
    await decryptData(saved.body.capsule, "12".repeat(32)),
  );
  expect(capsule.binding.message).toBe("private check-in note");
  expect(bodies).not.toContain(capsule.binding_nonce);
  expect(
    f.calls.find((call) => call.path.endsWith("/admit"))!.body
      .resource_binding_digest,
  ).toMatch(/^[a-f0-9]{64}$/);
});

it("a screen handoff cannot settle the underlying mutation as successful", async () => {
  const f = fixture({ screen: true });
  await f.runtime.submit("share location");
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(
    f.calls.find((call) => call.path.endsWith("/settle"))!.body.status,
  ).toBe("review_required");
  expect(f.views.at(-1)?.message).toBe(
    "Location screen opened. Continue the operation there.",
  );
});

it("does not claim a screen opened when navigation fails", async () => {
  const f = fixture({ screen: true });
  vi.mocked(f.ports.navigate).mockResolvedValue(false);
  await f.runtime.submit("share location");
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(
    f.calls.find((call) => call.path.endsWith("/settle"))!.body.status,
  ).toBe("review_required");
  expect(f.views.at(-1)?.message).toContain("could not open");
});

it("waits for canonical Location state before evaluating a newly mounted audience", async () => {
  const f = fixture();
  let finishLoad!: () => void;
  const loading = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  f.ports.reconcile = vi.fn(() => loading);
  mocks.prepare
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({
      status: "ready",
      binding: { target: "Alice" },
      summary: "Confirm Alice",
    });
  const task = f.runtime.submit("share with Alice");
  await vi.waitFor(() => expect(f.ports.reconcile).toHaveBeenCalled());
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(f.views.some((view) => view.gate?.kind === "input")).toBe(false);
  finishLoad();
  await task;
  expect(f.ports.navigate).toHaveBeenCalledWith("/one/location");
  expect(f.ports.execute).toHaveBeenCalledTimes(1);
});

it("reassesses a pending suffix after reconciling a completed step with changed capabilities", async () => {
  const f = fixture();
  const plan = {
    schema_version: "location.plan.v1",
    capability_revision: "old",
    context_revision: "ctx",
    mode: "end_to_end",
    steps: [
      { action_id: "location.first", slots: {} },
      { action_id: "location.next", slots: {} },
    ],
    gate: null,
  };
  const capsule = await encryptData(
    JSON.stringify({
      schema: "one.command.capsule.v1",
      owner: "owner",
      command: "cmd",
      plan,
    }),
    "12".repeat(32),
  );
  let checkpoint: any = {
    ...f.checkpoint(),
    status: "ready",
    step_count: 2,
    capsule,
  };
  const paths: string[] = [];
  mocks.apiFetch.mockImplementation(async (path, init) => {
    paths.push(path);
    let response: any;
    if (path.endsWith("/action-proposals/cmd"))
      response = {
        checkpoint,
        capability_revision: "new",
        outcome: { state: "settled" },
      };
    else if (path.endsWith("/resume") && checkpoint.next_step === 0) {
      checkpoint = { ...checkpoint, next_step: 1, revision: 2 };
      response = { status: "advanced", checkpoint };
    } else if (path.endsWith("/resolve"))
      response = {
        plan: { ...plan, capability_revision: "new" },
        assessment_token: "revalidated",
      };
    else if (path.endsWith("/checkpoint")) {
      checkpoint = {
        ...checkpoint,
        revision: 3,
        capsule: JSON.parse(init.body).capsule,
      };
      response = { checkpoint };
    } else
      response = {
        status: "needs_confirmation",
        directive: {
          directive_id: "next",
          operation_id: "next-op",
          context_revision: "ctx",
        },
      };
    return new Response(JSON.stringify(response));
  });
  await f.runtime.resume(checkpoint);
  expect(paths.filter((path) => path.endsWith("/resolve"))).toHaveLength(1);
  expect(paths.findIndex((path) => path.endsWith("/resolve"))).toBeGreaterThan(
    paths.findIndex((path) => path.endsWith("/resume")),
  );
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(f.views.at(-1)?.gate?.kind).toBe("confirmation");
});
