import { describe, expect, it, vi } from "vitest";

import { executeOneSystemActionThroughGateway } from "@/lib/agent/one-system-action-gateway-adapter";
import type { PendingOneSystemActionInvocation } from "@/lib/capacitor/one-system-action-invocation";

function invocation(
  overrides: Partial<PendingOneSystemActionInvocation> = {},
): PendingOneSystemActionInvocation {
  return {
    id: "action-request-1",
    kind: "execute_one_action",
    source: "siri_app_intent",
    actionId: "location.share_selected",
    slots: { resolvedRecipientId: "contact-1", duration_hours: "2" },
    requiresVault: true,
    confirmedBySystem: true,
    createdAt: 1_000,
    expiresAt: 301_000,
    ...overrides,
  };
}

function succeeded(actionId: string) {
  return {
    status: "succeeded" as const,
    actionId,
    label: actionId,
    routeBefore: "/one/location",
    resultSummary: `${actionId} succeeded`,
  };
}

describe("Apple system action → generated gateway adapter", () => {
  it("uses the same canonical executor for navigation, exact selection, and the final action", async () => {
    const execute = vi.fn(async (actionId: string) => succeeded(actionId));
    const afterSelection = vi.fn(async () => undefined);

    const result = await executeOneSystemActionThroughGateway({
      invocation: invocation(),
      execute,
      getCurrentRoute: () => ({ pathname: "/one", screen: "one_agents" }),
      waitForScreen: vi.fn(async () => true),
      afterSelection,
    });

    expect(result.status).toBe("succeeded");
    expect(execute).toHaveBeenNthCalledWith(1, "location.open_share", {});
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "location.select_share_recipient",
      { resolvedRecipientId: "contact-1" },
      {
        goalId: "goal.location.select_share_recipient",
        expectedScreen: "one_location",
      },
    );
    expect(execute).toHaveBeenNthCalledWith(
      3,
      "location.share_selected",
      { duration_hours: "2" },
      null,
    );
    expect(afterSelection).toHaveBeenCalledOnce();
  });

  it("passes a UI destination straight to the canonical executor", async () => {
    const execute = vi.fn(async (actionId: string) => succeeded(actionId));
    const request = invocation({
      actionId: "location.open_map",
      slots: {},
      requiresVault: false,
      confirmedBySystem: false,
    });

    await executeOneSystemActionThroughGateway({
      invocation: request,
      execute,
      getCurrentRoute: () => ({ pathname: "/one", screen: "one_agents" }),
      waitForScreen: vi.fn(),
      afterSelection: vi.fn(),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("location.open_map", {}, null);
  });

  it("fails closed before the gateway when system confirmation is absent", async () => {
    const execute = vi.fn();
    const result = await executeOneSystemActionThroughGateway({
      invocation: invocation({ confirmedBySystem: false }),
      execute,
      getCurrentRoute: () => ({
        pathname: "/one/location",
        screen: "one_location",
      }),
      waitForScreen: vi.fn(),
      afterSelection: vi.fn(),
    });

    expect(result.reason).toBe("system_confirmation_missing");
    expect(execute).not.toHaveBeenCalled();
  });

  it("never guesses a recipient when the structured entity is missing", async () => {
    const execute = vi.fn();
    const result = await executeOneSystemActionThroughGateway({
      invocation: invocation({ slots: { duration_hours: "2" } }),
      execute,
      getCurrentRoute: () => ({
        pathname: "/one/location",
        screen: "one_location",
      }),
      waitForScreen: vi.fn(),
      afterSelection: vi.fn(),
    });

    expect(result.reason).toBe("system_action_recipient_missing");
    expect(execute).not.toHaveBeenCalled();
  });
});
