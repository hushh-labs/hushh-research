import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharingRequestContext } from "@/lib/services/drive-sharing-service";

const requesterContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/drive-sharing-service", () => ({
  DriveSharingService: { requesterContext },
}));
import { useFeedPaymentContext } from "@/lib/feed/use-feed-payment-context";

function context(requestId: string, purpose = "Private request"): SharingRequestContext {
  return { requestId, purpose: { purpose, periodStart: null, periodEnd: null } };
}

describe("private Feed payment context", () => {
  beforeEach(() => vi.resetAllMocks());

  it("bounds reads, isolates failures and reuses successful context when a payment is added", async () => {
    const pending = new Map<string, { resolve: (value: SharingRequestContext) => void; reject: (reason: Error) => void }>();
    requesterContext.mockImplementation((_token, id) => new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    }));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const { result, rerender } = renderHook(({ ids }) => useFeedPaymentContext("user", "vault", ids), {
      initialProps: { ids: ["one", "two", "three"] },
    });
    expect(requesterContext).toHaveBeenCalledTimes(2);
    await act(async () => { pending.get("one")!.reject(new Error("unavailable")); });
    expect(requesterContext).toHaveBeenCalledTimes(3);
    await act(async () => {
      pending.get("two")!.resolve(context("two"));
      pending.get("three")!.resolve(context("three"));
    });
    expect(Object.keys(result.current).sort()).toEqual(["three", "two"]);
    rerender({ ids: ["two", "three", "four"] });
    await waitFor(() => expect(requesterContext).toHaveBeenCalledTimes(4));
    expect(requesterContext.mock.calls[3][1]).toBe("four");
    await act(async () => { pending.get("four")!.resolve(context("four")); });
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it("clears on lock or account change and discards a late private response", async () => {
    let resolveOld!: (value: SharingRequestContext) => void;
    requesterContext.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(context("one", "New account request"));
    const { result, rerender } = renderHook(({ uid, token }) => useFeedPaymentContext(uid, token, ["one"]), {
      initialProps: { uid: "old", token: "old-vault" as string | null },
    });
    const oldGuard = requesterContext.mock.calls[0][2];
    rerender({ uid: "new", token: "new-vault" });
    expect(() => oldGuard()).toThrow("Request context changed");
    await waitFor(() => expect(result.current.one?.purpose.purpose).toBe("New account request"));
    await act(async () => { resolveOld(context("one", "Old account private text")); });
    expect(result.current.one?.purpose.purpose).toBe("New account request");
    rerender({ uid: "new", token: null });
    expect(result.current).toEqual({});
  });
});
