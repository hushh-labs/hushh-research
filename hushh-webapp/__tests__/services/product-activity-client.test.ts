import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reset: null as null | ((owner: string) => void), token: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getFirebaseIdTokenForOwner: mocks.token, apiFetch: mocks.fetch } }));
vi.mock("@/lib/services/secure-durable-resource-service", () => ({ subscribeDurableOwnerReset: (fn: (owner: string) => void) => { mocks.reset = fn; return () => {}; } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.token.mockResolvedValue("synthetic-firebase-token");
  mocks.fetch.mockImplementation(async (_url, options) => new Response(JSON.stringify(options.method === "POST" ? { recorded: true } : { enabled: true, generation: "12345678-1234-1234-1234-123456789012" })));
});
const posts = () => mocks.fetch.mock.calls.filter((call) => call[1].method === "POST");
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const identity = await import("@/lib/auth/session-owner");
  identity.publishValidatedAuthSessionOwner("owner-a");
  const client = await import("@/lib/observability/product-activity-client");
  return { ...identity, ...client };
}
describe("private product observation lifecycle", () => {
  const navigation = () => ({ status: "started" as const, actionId: "setup.open_calendar", label: "Connect your calendar",
    routeBefore: "/one/setup", routeAfter: "/one/setup/calendar", screenBefore: "one_setup", screenAfter: "one_setup_calendar",
    resultSummary: "PRIVATE_RESULT", data: { privateValue: "PRIVATE_VALUE" } });
  const arrived = { getCurrentRoute: () => ({ pathname: "/one/setup/calendar", screen: "one_setup_calendar", subview: null }),
    getCurrentSurfaceMetadata: () => ({ screenId: "one_setup_calendar", title: "Calendar Setup", publisherRouteKey: "/one/setup/calendar" }) };

  it("reports a navigation terminal once only after its destination actually settles", async () => {
    const f = await fixture();
    const { settleAgentGatewayAction } = await import("@/lib/agent/agent-gateway-action-settlement");
    const value = navigation();
    const result = await f.observeDispatch(value.actionId, Promise.resolve(value));
    expect(result).toBe(value);
    await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0));
    const original = JSON.parse(posts()[0][1].body);
    const settled = await settleAgentGatewayAction(result, arrived);
    expect(settled.status).toBe("succeeded");
    await vi.waitFor(() => expect(posts().some(call => JSON.parse(call[1].body).phase === "returned")).toBe(true));
    await settleAgentGatewayAction(result, arrived);
    await settleAgentGatewayAction(settled, arrived);
    await new Promise(resolve => setTimeout(resolve, 0));
    const terminals = posts().map(call => JSON.parse(call[1].body)).filter(body => body.phase === "returned");
    expect(terminals).toEqual([{ ...original, phase: "returned" }]);
    expect(JSON.stringify(posts())).not.toMatch(/PRIVATE_RESULT|PRIVATE_VALUE|\/one\/setup\/calendar/);
  });

  it("keeps route timeout unknown and retains the original attempt for later settlement", async () => {
    const f = await fixture();
    const { settleAgentGatewayAction } = await import("@/lib/agent/agent-gateway-action-settlement");
    const value = navigation();
    const result = await f.observeDispatch(value.actionId, Promise.resolve(value));
    const waiting = await settleAgentGatewayAction(result, {
      getCurrentRoute: () => ({ pathname: "/one/setup", screen: "one_setup", subview: null }),
      getCurrentSurfaceMetadata: () => null, timeoutMs: 0,
    });
    expect(waiting.status).toBe("started");
    await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0));
    expect(posts().every(call => JSON.parse(call[1].body).phase === "started")).toBe(true);
    const original = JSON.parse(posts()[0][1].body);
    // Timeout describes the current screen, not the requested destination.
    // Its projection must never acquire terminal-report authority.
    await settleAgentGatewayAction(waiting, {
      getCurrentRoute: () => ({ pathname: "/one/setup", screen: "one_setup", subview: null }),
      getCurrentSurfaceMetadata: () => ({ screenId: "one_setup", title: "Setup", publisherRouteKey: "/one/setup" }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts().every(call => JSON.parse(call[1].body).phase === "started")).toBe(true);
    await settleAgentGatewayAction(result, arrived);
    await vi.waitFor(() => expect(posts().some(call => JSON.parse(call[1].body).phase === "returned")).toBe(true));
    expect(JSON.parse(posts().at(-1)![1].body)).toEqual({ ...original, phase: "returned" });
  });

  it.each(["reset", "switch"])("does not attach a delayed route terminal to an owner after %s", async change => {
    const f = await fixture();
    const { settleAgentGatewayAction } = await import("@/lib/agent/agent-gateway-action-settlement");
    const value = navigation();
    const result = await f.observeDispatch(value.actionId, Promise.resolve(value));
    await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const count = posts().length;
    if (change === "reset") mocks.reset!("owner-a");
    else f.publishValidatedAuthSessionOwner("owner-b");
    expect((await settleAgentGatewayAction(result, arrived)).status).toBe("succeeded");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts()).toHaveLength(count);
  });

  it("keeps a streamed attempt on its original epoch and admits only its first terminal", async () => {
    const f = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let epoch = "original-epoch";
    mocks.fetch.mockImplementation(async (_url, options) => new Response(JSON.stringify(
      options.method === "POST" ? { recorded: true } : { enabled: true, generation: epoch },
    )));
    const id = "12345678-1234-1234-1234-123456789012";
    const attempt = f.captureProductAttempt("chat:agent_one", "owner-a", id);
    attempt.settled("returned"); // No started run: no terminal evidence.
    attempt.started();
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    epoch = "new-epoch";
    clock.mockReturnValue(now + 60_001);
    f.observeProductEvent("one_memory_action", "detail_edited", "success");
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    attempt.started(); // A confirmation resume is still the original attempt.
    attempt.settled("returned");
    attempt.settled("failed");
    await vi.waitFor(() => expect(posts()).toHaveLength(3));
    const reports = posts().map((call) => JSON.parse(call[1].body)).filter((body) => body.operationId === id);
    expect(reports.map((body) => [body.phase, body.generation])).toEqual([
      ["started", "original-epoch"], ["returned", "original-epoch"],
    ]);
  });
  it.each(["reset", "switch"])("does not settle a streamed attempt after owner %s", async (change) => {
    const f = await fixture();
    const attempt = f.captureProductAttempt("chat:agent_one", "owner-a");
    attempt.started();
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    if (change === "reset") mocks.reset!("owner-a");
    else f.publishValidatedAuthSessionOwner("owner-b");
    attempt.settled("returned");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts()).toHaveLength(1);
  });
  it("refuses mismatched owners and keeps free-form message identifiers out of reports", async () => {
    const f = await fixture();
    const refused = f.captureProductAttempt("chat:agent_one", "owner-b");
    refused.started(); refused.settled("returned");
    expect(mocks.token).not.toHaveBeenCalled();
    const admitted = f.captureProductAttempt("chat:agent_one", "owner-a", "PRIVATE_MESSAGE_BODY");
    admitted.started(); admitted.settled("returned");
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.stringify(posts())).not.toContain("PRIVATE_MESSAGE_BODY");
    expect(new Set(posts().map((call) => JSON.parse(call[1].body).operationId)).size).toBe(1);
  });
  it("drains a burst after four in-flight reports without delaying product results", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options.method === "POST") await gate;
      return new Response(JSON.stringify(options.method === "POST" ? { recorded: true } : { enabled: true, generation: "original-epoch" }));
    });
    const values = Array.from({ length: 6 }, () => ({ status: "succeeded" }));
    const operations = values.map((value) => f.observeDispatch("calendar.event.create", Promise.resolve(value)));
    expect(await Promise.all(operations)).toEqual(values);
    await vi.waitFor(() => expect(posts()).toHaveLength(4));
    release();
    await vi.waitFor(() => expect(posts()).toHaveLength(12));
    const bodies = posts().map((call) => JSON.parse(call[1].body));
    expect(new Set(bodies.map((body) => body.operationId)).size).toBe(6);
    for (const id of new Set(bodies.map((body) => body.operationId))) {
      expect(bodies.filter((body) => body.operationId === id).map((body) => body.phase)).toEqual(["started", "returned"]);
    }
    expect(bodies.every((body) => body.generation === "original-epoch")).toBe(true);
  });
  it.each(["switch", "reset"])("discards queued reports after owner %s", async (change) => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options.method === "POST") await gate;
      return new Response(JSON.stringify(options.method === "POST" ? { recorded: true } : { enabled: true, generation: "capture-epoch" }));
    });
    for (let i = 0; i < 6; i++) f.observeProductAction("calendar.event.create", "started", `old-operation-${i}`);
    await vi.waitFor(() => expect(posts()).toHaveLength(4));
    if (change === "switch") f.publishValidatedAuthSessionOwner("owner-b");
    else mocks.reset!("owner-a");
    f.observeProductAction("calendar.event.create", "started", "current-operation");
    release();
    await vi.waitFor(() => expect(posts()).toHaveLength(5));
    expect(posts().map((call) => JSON.parse(call[1].body).operationId)).toEqual([
      "old-operation-0", "old-operation-1", "old-operation-2", "old-operation-3", "current-operation",
    ]);
  });
  it.each(["capacity", "expiry"])("bounds queued observation retention by %s", async (limit) => {
    const f = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options.method === "POST") await gate;
      return new Response(JSON.stringify(options.method === "POST" ? { recorded: true } : { enabled: true, generation: "capture-epoch" }));
    });
    for (let i = 0; i < (limit === "capacity" ? 1000 : 6); i++)
      f.observeProductAction("calendar.event.create", "started", `bounded-operation-${i}`);
    await vi.waitFor(() => expect(posts()).toHaveLength(4));
    if (limit === "expiry") clock.mockReturnValue(now + 60_001);
    release();
    // A new report proves the drain finished; expired or overflowed records must
    // not reappear after the transport becomes available.
    await vi.waitFor(() => expect(posts()).toHaveLength(limit === "capacity" ? 68 : 4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.observeProductAction("calendar.event.create", "returned", "fresh-operation");
    await vi.waitFor(() => expect(posts()).toHaveLength(limit === "capacity" ? 69 : 5));
    expect(JSON.parse(posts().at(-1)![1].body).operationId).toBe("fresh-operation");
  });
  it("refreshes admission for new operations after a remote reset without rebinding pending terminal reports", async () => {
    const f = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let epoch = "old-epoch";
    mocks.fetch.mockImplementation(async (_url, options) => new Response(JSON.stringify(options.method === "POST" ? { recorded: false } : { enabled: true, generation: epoch })));
    let complete!: (value: { status: string }) => void;
    const pending = f.observeDispatch("calendar.event.create", new Promise((resolve) => { complete = resolve; }));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    epoch = "new-epoch";
    clock.mockReturnValue(now + 60_001);
    f.observeProductEvent("one_memory_action", "detail_edited", "success");
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    complete({ status: "succeeded" }); await pending;
    await vi.waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts().map((call) => JSON.parse(call[1].body).generation)).toEqual(["old-epoch", "new-epoch", "old-epoch"]);
    expect(mocks.fetch.mock.calls.filter((call) => call[1].method !== "POST")).toHaveLength(2);
  });
  it("pins dispatch ownership and preserves the actual result across account switching", async () => {
    const f = await fixture();
    let complete!: (value: { status: string; privateContent: string }) => void;
    const result = f.observeDispatch("calendar.event.create", new Promise((resolve) => { complete = resolve; }));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(mocks.token).toHaveBeenCalledWith("owner-a");
    f.publishValidatedAuthSessionOwner("owner-b");
    const value = { status: "succeeded", privateContent: "PRIVATE" };
    complete(value);
    expect(await result).toBe(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts()).toHaveLength(1);
    f.observeProductEvent("one_memory_action", "detail_edited", "success");
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    const body = JSON.parse(posts()[0][1].body);
    expect(Object.keys(body).sort()).toEqual(["actionId", "generation", "operationId", "phase"]);
    expect(JSON.stringify(posts())).not.toContain("PRIVATE");
  });
  it("fences old work on same-owner reset and acquires the next epoch for new actions", async () => {
    const f = await fixture();
    let complete!: (value: { status: string }) => void;
    const result = f.observeDispatch("calendar.event.create", new Promise((resolve) => { complete = resolve; }));
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    mocks.reset!("owner-a");
    complete({ status: "succeeded" }); await result;
    f.observeProductEvent("one_memory_action", "detail_edited", "success");
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(mocks.fetch.mock.calls.filter((call) => call[1].method !== "POST")).toHaveLength(2);
  });
  it("drops deferred old-owner events, undeclared action values, and preserves failures", async () => {
    const f = await fixture();
    const { snapshotProductActivityScope } = await import("@/lib/observability/product-activity-scope");
    const scope = snapshotProductActivityScope();
    f.publishValidatedAuthSessionOwner("owner-b");
    f.observeProductEvent("one_memory_action", "detail_edited", "success", scope);
    f.observeProductEvent("one_memory_action", "PRIVATE_DYNAMIC_ACTION", "success");
    await Promise.resolve();
    expect(mocks.token).not.toHaveBeenCalled();
    const failure = new Error("PRIVATE_ERROR");
    await expect(f.observeDispatch("calendar.event.create", Promise.reject(failure))).rejects.toBe(failure);
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.stringify(posts())).not.toContain("PRIVATE_ERROR");
  });
  it.each([
    new DOMException("PRIVATE_ABORT", "AbortError"),
    new DOMException("PRIVATE_TIMEOUT", "TimeoutError"),
    Object.assign(new Error("PRIVATE_ABORT"), { name: "AbortError" }),
    Object.assign(new Error("PRIVATE_TIMEOUT"), { name: "TimeoutError" }),
  ])("keeps a rejected $name dispatch unknown without changing its rejection", async (error) => {
    const f = await fixture();
    await expect(f.observeDispatch("calendar.event.create", Promise.reject(error))).rejects.toBe(error);
    await vi.waitFor(() => expect(posts().length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posts().map(call => JSON.parse(call[1].body).phase)).toEqual(["started"]);
    expect(JSON.stringify(posts())).not.toMatch(/PRIVATE_ABORT|PRIVATE_TIMEOUT/);
  });
});
