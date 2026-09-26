// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { decryptData, encryptData } from "@/lib/vault/encrypt";
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ownerPodRequest: vi.fn(),
  prepare: vi.fn(),
  action: vi.fn(),
  permission: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mocks.apiFetch,
    ownerPodRequest: mocks.ownerPodRequest,
  },
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
  mocks.ownerPodRequest.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          assessment: { steps: [], unsupported: false },
          capability_revision: "test",
          observations: [],
        }),
      ),
  );
});

it("starts a fresh private transcription after pause and cancels capture independently", async () => {
  const f = fixture({ confirmation: true });
  f.runtime.pause();
  mocks.ownerPodRequest.mockImplementation(async (path, init) => {
    expect(path).toBe("commands/transcriptions");
    expect(init.signal.aborted).toBe(false);
    expect(init.headers.Authorization).toBeUndefined();
    return new Response(JSON.stringify({ transcript: "Share with Alice" }));
  });
  expect(await f.runtime.transcribe("synthetic-audio")).toBe(
    "Share with Alice",
  );
  f.runtime.cancelTranscription();
  expect(mocks.ownerPodRequest.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(f.calls).toEqual([]);
});

it("keeps a failed cancellation retry bound to the same command", async () => {
  const f = fixture({ confirmation: true });
  await f.runtime.submit("Share with Alice");
  const base = mocks.apiFetch.getMockImplementation()!;
  let deletes = 0;
  mocks.apiFetch.mockImplementation(async (path, init) => {
    if (init.method === "DELETE") {
      expect(path).toBe("/api/one/action-proposals/cmd");
      if (++deletes === 1) throw new Error("Response lost");
      return new Response(
        JSON.stringify({
          checkpoint: { ...f.checkpoint(), status: "cancelled", capsule: null },
        }),
      );
    }
    return base(path, init);
  });
  await expect(f.runtime.cancel()).rejects.toThrow("Response lost");
  await expect(f.runtime.submit("Another task")).rejects.toThrow("cancel");
  await f.runtime.refresh();
  expect(deletes).toBe(2);
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(f.views.at(-1)).toMatchObject({ phase: "idle" });
});

it("clears an expired cancellation target without reviving its task", async () => {
  const f = fixture({ confirmation: true });
  await f.runtime.submit("Share with Alice");
  const base = mocks.apiFetch.getMockImplementation()!;
  mocks.apiFetch.mockImplementation(async (path, init) =>
    init.method === "DELETE"
      ? new Response(JSON.stringify({ detail: "Command not found" }), {
          status: 404,
        })
      : base(path, init),
  );
  await f.runtime.cancel();
  expect(f.views.at(-1)).toMatchObject({ phase: "idle" });
  await f.runtime.submit("A new task");
  expect(f.views.at(-1)).toMatchObject({ phase: "gate" });
  expect(f.ports.execute).not.toHaveBeenCalled();
});

it.each([false, true])(
  "reloads a rejected or lost replan before any execution (server committed: %s)",
  async (committed) => {
    const f = fixture({ confirmation: true });
    await f.runtime.submit("Share with Alice");
    const original = f.checkpoint();
    const base = mocks.apiFetch.getMockImplementation()!;
    let resumedCapsule: any;
    let replacementWritten = false;
    mocks.apiFetch.mockImplementation(async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (path.endsWith("/resolve"))
        return new Response(
          JSON.stringify({
            plan: {
              schema_version: "location.plan.v1",
              capability_revision: "cap",
              context_revision: "ctx",
              mode: "end_to_end",
              steps: [{ action_id: "location.test", slots: { person: "Bob" } }],
              gate: null,
            },
            assessment_token: "assessment",
          }),
        );
      if (path.endsWith("/checkpoint") && body.assessment_token) {
        replacementWritten = true;
        resumedCapsule = committed ? body.capsule : original.capsule;
        throw new Error("Checkpoint response unavailable");
      }
      if (
        path.endsWith("/action-proposals/cmd") &&
        init.method === "GET" &&
        replacementWritten
      )
        return new Response(
          JSON.stringify({
            checkpoint: { ...original, capsule: resumedCapsule },
          }),
        );
      return base(path, init);
    });
    await expect(f.runtime.resolve("Use Bob instead")).rejects.toThrow(
      "Checkpoint response",
    );
    await expect(f.runtime.continueGate(true)).rejects.toThrow(
      "Refresh / Resume",
    );
    expect(f.ports.execute).not.toHaveBeenCalled();
    await f.runtime.refresh();
    const preparation = mocks.prepare.mock.calls.at(-1)!;
    expect(preparation[1]).toEqual(committed ? { person: "Bob" } : {});
    expect(f.ports.execute).not.toHaveBeenCalled();
  },
);

it("remembers a verified created circle for the next command", async () => {
  const f = fixture({ actionId: "location.create_circle" });
  mocks.action.mockReturnValue({
    action_id: "location.create_circle",
    command: { backend_binding: "fixture" },
  });
  const observation = {
    reference: `candidate_${"a".repeat(32)}`,
    kind: "circle",
    id: "created-circle-id",
    name: "Goa",
    observed_at: new Date().toISOString(),
  };
  const base = mocks.apiFetch.getMockImplementation()!;
  let completed = false;
  let followup: any;
  mocks.apiFetch.mockImplementation(async (path, init) => {
    if (path.endsWith("/execute")) {
      completed = true;
      return new Response(
        JSON.stringify({
          checkpoint: {
            ...f.checkpoint(),
            status: "completed",
            next_step: 1,
            capsule: null,
          },
        }),
      );
    }
    if (path.endsWith("/action-proposals/cmd") && completed)
      return new Response(JSON.stringify({ observations: [observation] }));
    if (path.endsWith("agent-chat/proposals") && completed) {
      followup = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ recovery_required: true, checkpoint: f.checkpoint() }),
      );
    }
    return base(path, init);
  });
  await f.runtime.submit("Create Goa");
  expect(f.views.at(-1)?.phase).toBe("result");
  await f.runtime.submit("Add Abdul to that circle");
  const direct = mocks.ownerPodRequest.mock.calls.at(-1)!;
  expect(direct[0]).toBe("commands/assess");
  expect(JSON.parse(direct[1].body).observations).toEqual([observation]);
  expect(followup.query).toBeUndefined();
  expect(followup.semantic).toBeDefined();
});

it("settles a platform share handoff once, with no Continue loop or mutation success", async () => {
  const f = fixture({ screen: true, actionId: "location.share_public_link" });
  const summary =
    "Links opened. Tap Share to contacts. The link has not been sent.";
  mocks.prepare.mockResolvedValue({ status: "simulate", summary });
  await f.runtime.submit("Share my live link on WhatsApp");
  expect(
    f.calls.find((call) => call.path.endsWith("/admit"))?.body.prefer_screen,
  ).toBe(true);
  expect(f.ports.navigate).toHaveBeenCalledOnce();
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(
    f.calls.find((call) => call.path.endsWith("/settle"))?.body.status,
  ).toBe("review_required");
  expect(f.checkpoint().capsule).toBeNull();
  expect(f.views.at(-1)).toMatchObject({ phase: "result", message: summary });
  const calls = f.calls.length;
  await f.runtime.continueGate(true);
  expect(f.calls).toHaveLength(calls);
});

function fixture(
  options: {
    confirmation?: boolean;
    uncertain?: boolean;
    permission?: boolean;
    screen?: boolean;
    verifiedMembership?: boolean;
    actionId?: string;
  } = {},
) {
  const plan = {
    schema_version: "location.plan.v1",
    capability_revision: "cap",
    context_revision: "ctx",
    mode: "end_to_end",
    steps: [{ action_id: options.actionId || "location.test", slots: {} }],
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
    action_id: options.actionId || "location.test",
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
    if (path.endsWith("agent-chat/proposals/prepare"))
      response = { scopeToken: "scoped-read" };
    else if (path.endsWith("agent-chat/proposals"))
      response = { plan, checkpoint };
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
        status:
          options.verifiedMembership || body.status === "succeeded"
            ? "completed"
            : "review_required",
        capsule: null,
      };
      response = {
        checkpoint,
        ...(options.verifiedMembership
          ? { settlement_status: "succeeded", verified_membership_result: true }
          : {}),
      };
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
    execute: vi.fn().mockResolvedValue({
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

it.each([false, true])(
  "retains the encrypted original selection across partial settlement and Resume (lost renewal response: %s)",
  async (lostRenewalResponse) => {
    const f = fixture({ confirmation: true });
    const original = {
      owner: "owner",
      recipientIds: ["first", "second"],
      people: [
        { id: "first", name: "First", ready: true },
        { id: "second", name: "Second", ready: true },
      ],
      duration: "1",
      replacements: [],
    };
    mocks.prepare.mockResolvedValue({
      status: "ready",
      binding: original,
      summary: "Ask both people",
    });
    mocks.action.mockReturnValue({
      action_id: "location.test",
      label: "Ask for Location",
      meaning: "Ask the selected people",
      execution_target: { status: "wired", path: "local_handler" },
      command: {
        review_route: "/one/location",
        client_receipt: "location.audience.v1",
      },
    });
    const base = mocks.apiFetch.getMockImplementation()!;
    let partial = false,
      finished = false,
      renewalLost = false;
    const resumeCalls: any[] = [];
    mocks.apiFetch.mockImplementation(async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (path.endsWith("/settle") && !finished) {
        partial = true;
        return new Response(
          JSON.stringify({
            checkpoint: f.checkpoint(),
            resume_required: true,
            settlement_status: "review_required",
          }),
        );
      }
      if (path.endsWith("/action-proposals/cmd") && partial)
        return new Response(
          JSON.stringify({
            checkpoint: f.checkpoint(),
            outcome: { state: "consumed", consumed_at: "fixture" },
          }),
        );
      if (path.endsWith("/resume") && partial) {
        resumeCalls.push(body);
        expect(JSON.parse(body.preparation.binding_json)).toEqual(original);
        if (body.resume_snapshot && lostRenewalResponse && !renewalLost) {
          renewalLost = true;
          throw Error("The renewal committed, but its response was lost.");
        }
        return new Response(
          JSON.stringify(
            body.resume_snapshot
              ? {
                  status: "needs_confirmation",
                  directive: {
                    directive_id: "renewed",
                    operation_id: "a".repeat(64),
                    context_revision: "ctx",
                  },
                }
              : {
                  status: "resume_preparation_required",
                  continuation: {
                    kind: "audience",
                    operation_id: "a".repeat(64),
                    snapshot: (renewalLost ? "c" : "b").repeat(64),
                    total_units: 2,
                    completed_unit_indices: [0],
                    pending_unit_indices: [1],
                  },
                },
          ),
        );
      }
      if (path.endsWith("/claim") && partial) {
        const response = await base(path, init);
        return new Response(
          JSON.stringify({
            ...(await response.json()),
            operation_id: "a".repeat(64),
            directive_id: "renewed",
          }),
        );
      }
      return base(path, init);
    });
    vi.mocked(f.ports.execute).mockResolvedValueOnce({
      status: "failed",
      actionId: "location.test",
      label: null,
      routeBefore: null,
      resultSummary: "First request sent; the second response was lost.",
    });
    await f.runtime.submit("Ask both people for Location");
    await f.runtime.continueGate(true);
    expect(f.views.at(-1)?.phase).toBe("recovery");
    expect(f.checkpoint().next_step).toBe(0);
    const capsule = JSON.parse(
      await decryptData(f.checkpoint().capsule, "12".repeat(32)),
    );
    expect(capsule.binding).toEqual(original);
    mocks.prepare.mockImplementation(
      async (_action, _slots, _choice, _resources, continuation) => {
        expect(continuation).toMatchObject({
          completedUnitIndices: [0],
          pendingUnitIndices: [1],
          originalBinding: original,
        });
        return {
          status: "ready",
          binding: original,
          summary: "Ask Second; First is complete",
        };
      },
    );
    const resumed = new LocationCommandRuntime(f.ports);
    if (lostRenewalResponse) {
      await expect(resumed.resume(f.checkpoint())).rejects.toThrow(
        "response was lost",
      );
      await resumed.continueGate(true);
      expect(resumeCalls[2].resume_snapshot).toBeUndefined();
      expect(resumeCalls[3].resume_snapshot).toBe("c".repeat(64));
    } else await resumed.resume(f.checkpoint());
    expect(resumeCalls).toHaveLength(lostRenewalResponse ? 4 : 2);
    expect(resumeCalls[1].resume_snapshot).toBe("b".repeat(64));
    expect(resumeCalls[1].preparation).toEqual(resumeCalls[0].preparation);
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
    expect(f.views.at(-1)?.gate?.kind).toBe("confirmation");
    finished = true;
    await resumed.continueGate(true);
    expect(f.ports.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.ports.execute).mock.calls[1]![2]).toMatchObject({
      preparedBinding: original,
      continuation: { pendingUnitIndices: [1], completedUnitIndices: [0] },
    });
    expect(f.checkpoint().status).toBe("completed");
    expect(f.checkpoint().capsule).toBeNull();
  },
);

it("persists private check-in inputs only inside the encrypted owner capsule", async () => {
  const f = fixture({ confirmation: true, actionId: "location.send_check_in" });
  const privateContinuation = {
    kind: "private_check_in" as const,
    owner: "owner",
    salt: "ab".repeat(32),
    point: {
      latitude: 1,
      longitude: 2,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web" as const,
    },
    note: "Synthetic private note",
    reviewedAt: new Date().toISOString(),
    recipientIds: ["Alice"],
    recipientKeys: { Alice: "key" },
    duration: "1",
    sourceCircleId: null,
  };
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding: { target: "Alice", privateDraftDigest: "c".repeat(64) },
    privateContinuation,
    summary: "Review Alice",
  });
  await f.runtime.submit("Send a private check-in");
  const decoded = JSON.parse(
    await decryptData(f.checkpoint().capsule, "12".repeat(32)),
  );
  expect(decoded.private_continuation).toEqual(privateContinuation);
  f.runtime.pause();
  const resumed = new LocationCommandRuntime(f.ports);
  await resumed.resume(f.checkpoint());
  expect(mocks.prepare).toHaveBeenLastCalledWith(
    "location.send_check_in",
    {},
    undefined,
    undefined,
    undefined,
    privateContinuation,
  );
  await resumed.continueGate(true);
  expect(
    vi.mocked(f.ports.execute).mock.calls[0]![2].privateContinuation,
  ).toEqual(privateContinuation);
  expect(JSON.stringify(f.calls)).not.toMatch(
    /latitude|longitude|Synthetic private note/,
  );
  expect(f.checkpoint().capsule).toBeNull();
});

it("uses the owning service's complete receipts after a lost final membership response", async () => {
  const f = fixture({ verifiedMembership: true });
  vi.mocked(f.ports.execute).mockResolvedValue({
    status: "failed",
    actionId: "location.add_to_circle",
    label: null,
    routeBefore: null,
    resultSummary: "The final response was lost. Review the circle.",
  });
  await f.runtime.submit("Add the selected connections to Goa");
  expect(
    f.calls.find((call) => call.path.endsWith("/settle"))!.body.status,
  ).toBe("review_required");
  expect(f.ports.execute).toHaveBeenCalledOnce();
  expect(f.views.at(-1)).toMatchObject({
    phase: "result",
    message: "Circle membership completed and verified by Location.",
  });
  expect(f.checkpoint().status).toBe("completed");
});

it("checkpoints an exact Connect prerequisite, leaves its review open, then refreshes the same step", async () => {
  const f = fixture();
  mocks.prepare.mockResolvedValue({
    status: "blocked",
    gate: "navigation",
    waitForUser: true,
    resolvedChoiceId: "exact-person",
    route: "/connect?reviewPerson=person-1",
    summary: "Wait for this connection.",
  });
  await f.runtime.submit("Add Abdul");
  const saved = JSON.parse(
    await decryptData(f.checkpoint().capsule, "12".repeat(32)),
  );
  expect(saved.chosen_resource_id).toBe("exact-person");
  await f.runtime.continueGate(true);
  expect(f.ports.navigate).toHaveBeenLastCalledWith(
    "/connect?reviewPerson=person-1",
  );
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(f.checkpoint().next_step).toBe(0);
  expect(f.views.at(-1)).toMatchObject({
    phase: "gate",
    gate: { waitForUser: true, route: undefined },
  });
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding: { person: "person-1" },
    summary: "Add Abdul",
  });
  await f.runtime.continueGate(true);
  expect(mocks.prepare).toHaveBeenLastCalledWith(
    "location.test",
    {},
    "exact-person",
    undefined,
    undefined,
    undefined,
  );
  expect(f.ports.execute).toHaveBeenCalledOnce();
});

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

it("updates private recovery information without replacing unchanged reviewed authority", async () => {
  const f = fixture({ permission: true });
  mocks.permission.mockResolvedValue({ state: "prompt" });
  mocks.requestPermission.mockResolvedValue({ state: "granted" });
  const binding = { target: "Alice" };
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding,
    summary: "Review Alice",
  });
  await f.runtime.submit("Check in");
  const before = JSON.parse(
    await decryptData(f.checkpoint().capsule, "12".repeat(32)),
  );
  const privateContinuation = {
    kind: "private_check_in",
    owner: "owner",
    salt: "ab".repeat(32),
    point: {
      latitude: 1,
      longitude: 2,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web",
    },
    note: "Synthetic note",
    reviewedAt: new Date().toISOString(),
    recipientIds: ["Alice"],
    recipientKeys: { Alice: "key" },
    duration: "1",
    sourceCircleId: null,
  };
  mocks.prepare.mockResolvedValue({
    status: "ready",
    binding,
    privateContinuation,
    summary: "Review Alice",
  });
  await f.runtime.continueGate(true);
  const last = f.calls
    .filter((call) => call.path.endsWith("/checkpoint"))
    .at(-1)!;
  const after = JSON.parse(
    await decryptData(last.body.capsule, "12".repeat(32)),
  );
  expect(after.binding_nonce).toBe(before.binding_nonce);
  expect(after.private_continuation).toEqual(privateContinuation);
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
  mocks.prepare.mockResolvedValueOnce(undefined).mockResolvedValue({
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
  expect(f.ports.navigate).toHaveBeenCalledWith(
    "/one/location",
    "location.test",
  );
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
