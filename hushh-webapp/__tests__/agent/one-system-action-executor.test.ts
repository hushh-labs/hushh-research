import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeOneSystemActionInvocation,
  isOneSystemActionExecutorReady,
  registerOneSystemActionExecutor,
} from "@/lib/agent/one-system-action-executor";
import type { PendingOneSystemActionInvocation } from "@/lib/capacitor/one-system-action-invocation";

const invocation: PendingOneSystemActionInvocation = {
  id: "request-1",
  kind: "execute_one_action",
  source: "siri_app_intent",
  actionId: "location.share_selected",
  slots: {
    person: "Kushal",
    resolvedRecipientId: "contact-1",
    duration_hours: "2",
  },
  requiresVault: true,
  confirmedBySystem: true,
  createdAt: 1_000,
  expiresAt: 301_000,
};

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("One system action executor seam", () => {
  it("fails closed until the sole Agent Bar owner registers", async () => {
    const result = await executeOneSystemActionInvocation(invocation);
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("system_action_executor_not_ready");
  });

  it("hands the unchanged canonical action id and slots to the owner", async () => {
    const executor = vi.fn(async (received) => ({
      status: "succeeded" as const,
      actionId: received.actionId,
      label: "Share with the people I picked",
      routeBefore: "/one/location",
      resultSummary: "Location shared with 1 person for 2 hours.",
    }));
    cleanup = registerOneSystemActionExecutor(executor);

    expect(isOneSystemActionExecutorReady()).toBe(true);
    const result = await executeOneSystemActionInvocation(invocation);

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(invocation);
    expect(result.actionId).toBe("location.share_selected");
  });

  it("unregisters only the owner that installed the active executor", () => {
    const firstCleanup = registerOneSystemActionExecutor(vi.fn());
    cleanup = registerOneSystemActionExecutor(vi.fn());
    firstCleanup();
    expect(isOneSystemActionExecutorReady()).toBe(true);
    cleanup();
    cleanup = null;
    expect(isOneSystemActionExecutorReady()).toBe(false);
  });
});
