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
});
