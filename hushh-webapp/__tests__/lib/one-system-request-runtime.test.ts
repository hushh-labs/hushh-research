import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OneSystemRequestRuntime } from "@/lib/agent/one-system-request-runtime";
import { OneSystemRequestInvocationBridge } from "@/lib/capacitor/one-system-request-invocation";
import type { PendingOneSystemRequestInvocation } from "@/lib/capacitor/one-system-request-invocation";

const pending: PendingOneSystemRequestInvocation = {
  id: "request-1",
  kind: "interpret_one_request",
  source: "siri_app_shortcut",
  createdAt: Date.now(),
  expiresAt: Date.now() + 300_000,
  handoffDeadlineAt: Date.now() + 25_000,
  protocolVersion: "one.request.v1",
  ownerBinding: "owner-1",
};

describe("OneSystemRequestRuntime", () => {
  beforeEach(() => {
    vi.spyOn(OneSystemRequestInvocationBridge, "claimRequest").mockResolvedValue({
      claimed: true,
      requestText: "enable location",
    });
    vi.spyOn(OneSystemRequestInvocationBridge, "reportProgress").mockResolvedValue({
      reported: true,
    });
    vi.spyOn(OneSystemRequestInvocationBridge, "completeRequest").mockResolvedValue();
    vi.spyOn(OneSystemRequestInvocationBridge, "cancelRequest").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims raw text once, fences app ownership, and releases text after ownership", async () => {
    const runtime = new OneSystemRequestRuntime();
    runtime.setOwner("owner-1");

    await (runtime as unknown as {
      handleNativeAvailability: (value: PendingOneSystemRequestInvocation) => Promise<void>;
    }).handleNativeAvailability(pending);

    expect(OneSystemRequestInvocationBridge.claimRequest).toHaveBeenCalledWith({
      id: pending.id,
    });
    expect(runtime.getCurrentState()).toEqual({
      status: "claimed",
      invocation: { ...pending, requestText: "enable location" },
    });

    expect(await runtime.markAppOwned()).toBe(true);
    expect(runtime.getCurrentState()).toEqual({
      status: "processing",
      invocation: pending,
    });
    expect(OneSystemRequestInvocationBridge.reportProgress).toHaveBeenCalledWith({
      id: pending.id,
      state: "app_owned",
    });
  });

  it("ignores a retained duplicate envelope instead of claiming twice", async () => {
    const runtime = new OneSystemRequestRuntime();
    runtime.setOwner("owner-1");
    const handler = runtime as unknown as {
      handleNativeAvailability: (value: PendingOneSystemRequestInvocation) => Promise<void>;
    };

    await handler.handleNativeAvailability(pending);
    await handler.handleNativeAvailability(pending);

    expect(OneSystemRequestInvocationBridge.claimRequest).toHaveBeenCalledTimes(1);
  });

  it("cancels only the active invocation id", async () => {
    const runtime = new OneSystemRequestRuntime();
    runtime.setOwner("owner-1");
    await (runtime as unknown as {
      handleNativeAvailability: (value: PendingOneSystemRequestInvocation) => Promise<void>;
    }).handleNativeAvailability(pending);

    await runtime.cancelCurrent("detached");

    expect(OneSystemRequestInvocationBridge.cancelRequest).toHaveBeenCalledWith(
      pending.id,
    );
    expect(runtime.getCurrentState()).toEqual({ status: "cancelled" });
  });
});
