import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "reviewer-a", unlocked: true,
  connector: vi.fn(), create: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({
  isVaultUnlocked: state.unlocked, vaultKey: state.unlocked ? "test-key" : null, vaultOwnerToken: "test-token",
}) }));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: { ensureConnector: state.connector } }));
vi.mock("@/lib/services/person-profile-service", () => ({ PersonProfileService: { createInformationRequest: state.create } }));

import { usePersonInformationRequest } from "@/lib/consent/use-person-information-request";

const draft = { scopeRefs: ["opaque-2", "opaque-1"], purpose: "Synthetic consent test", durationHours: 24 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

describe("shared explicit information request submission", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.uid = "reviewer-a"; state.unlocked = true;
    state.connector.mockResolvedValue({ connector_key_id: "connector-a" });
    state.create.mockResolvedValue({ bundleId: "synthetic-bundle" });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("does nothing on mount and requires unlocked authority and valid fields", async () => {
    const { result, rerender } = renderHook(() => usePersonInformationRequest("person-b"));
    expect(state.connector).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.submit({ ...draft, purpose: "short" })).toBe(false); });
    await act(async () => { expect(await result.current.submit({ ...draft, scopeRefs: Array.from({ length: 51 }, (_, i) => String(i)) })).toBe(false); });
    state.unlocked = false; rerender();
    await act(async () => { expect(await result.current.submit(draft)).toBe(false); });
    expect(state.create).not.toHaveBeenCalled();
  });

  it("binds submission to the chosen person and deduplicates simultaneous clicks", async () => {
    const prepared = deferred<{ connector_key_id: string }>();
    state.connector.mockReturnValueOnce(prepared.promise);
    const { result } = renderHook(() => usePersonInformationRequest("person-b"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.submit(draft); });
    await act(async () => { expect(await result.current.submit(draft)).toBe(false); });
    await act(async () => { prepared.resolve({ connector_key_id: "connector-a" }); expect(await first).toBe(true); });
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ personRef: "person-b", scopeRefs: ["opaque-1", "opaque-2"], connectorKeyId: "connector-a" }));
  });

  it("reuses the same key after a lost acknowledgement, but rotates it for an edited draft", async () => {
    state.create.mockRejectedValue(new Error("Lost acknowledgement"));
    const { result } = renderHook(() => usePersonInformationRequest("person-b"));
    await act(async () => { await result.current.submit(draft); });
    await act(async () => { await result.current.submit({ ...draft, scopeRefs: [...draft.scopeRefs].reverse() }); });
    await act(async () => { await result.current.submit({ ...draft, purpose: "Changed synthetic purpose" }); });
    const keys = state.create.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1]);
    expect(result.current.error).toMatch(/choices are kept/);
  });

  it.each(["lock", "owner", "person"])("rejects a late connector result after %s changes", async change => {
    const prepared = deferred<{ connector_key_id: string }>();
    state.connector.mockReturnValueOnce(prepared.promise);
    const { result, rerender } = renderHook(({ person }) => usePersonInformationRequest(person), { initialProps: { person: "person-b" } });
    let first!: Promise<boolean>;
    act(() => { first = result.current.submit(draft); });
    if (change === "lock") state.unlocked = false;
    if (change === "owner") state.uid = "reviewer-c";
    rerender({ person: change === "person" ? "person-c" : "person-b" });
    await act(async () => { prepared.resolve({ connector_key_id: "old-connector" }); expect(await first).toBe(false); });
    expect(state.create).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it("bounds a stalled preparation and lets the unchanged draft retry", async () => {
    vi.useFakeTimers();
    state.connector.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => usePersonInformationRequest("person-b"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.submit(draft); });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); expect(await first).toBe(false); });
    expect(result.current.error).toMatch(/Retry to check the same request/);
    await act(async () => { expect(await result.current.submit(draft)).toBe(true); });
    expect(state.create).toHaveBeenCalledTimes(1);
  });
});
