import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: { uid: "user-1" } as { uid: string } | null, loading: false },
  runtime: {
    appRuntimeState: { route: { pathname: "/one/location" } } as object | null,
    tier: "signed_unlocked" as "signed_locked" | "signed_unlocked" | null,
  },
  pathname: "/one/location",
  search: "view=people",
  visible: true,
  push: vi.fn(),
  getPendingInvocation: vi.fn(),
  claimInvocation: vi.fn(),
  completeInvocation: vi.fn(),
  addAvailabilityListener: vi.fn(),
  removeAvailabilityListener: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeStateOptional: () => mocks.runtime,
}));

vi.mock("@/lib/capacitor/one-system-action-invocation", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/capacitor/one-system-action-invocation")
    >();
  return {
    ...original,
    OneSystemActionInvocationBridge: {
      isSupported: () => true,
      getPendingInvocation: mocks.getPendingInvocation,
      claimInvocation: mocks.claimInvocation,
      completeInvocation: mocks.completeInvocation,
      addAvailabilityListener: mocks.addAvailabilityListener,
    },
  };
});

import { SiriOneActionHandoff } from "@/components/agent/siri-one-action-handoff";
import { registerOneSystemActionExecutor } from "@/lib/agent/one-system-action-executor";
import type { PendingOneSystemActionInvocation } from "@/lib/capacitor/one-system-action-invocation";

function invocation(
  overrides: Partial<PendingOneSystemActionInvocation> = {},
): PendingOneSystemActionInvocation {
  const now = Date.now();
  return {
    id: "action-request-1",
    kind: "execute_one_action",
    source: "siri_app_intent",
    actionId: "location.share_selected",
    slots: { resolvedRecipientId: "contact-1", duration_hours: "2" },
    requiresVault: true,
    confirmedBySystem: true,
    createdAt: now,
    expiresAt: now + 300_000,
    ...overrides,
  };
}

describe("SiriOneActionHandoff lifecycle", () => {
  let unregisterExecutor: (() => void) | null = null;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.auth = { user: { uid: "user-1" }, loading: false };
    mocks.runtime = {
      appRuntimeState: { route: { pathname: "/one/location" } },
      tier: "signed_unlocked",
    };
    mocks.pathname = "/one/location";
    mocks.search = "view=people";
    mocks.visible = true;
    mocks.push.mockReset();
    mocks.getPendingInvocation.mockReset();
    mocks.claimInvocation.mockReset();
    mocks.completeInvocation.mockReset();
    mocks.addAvailabilityListener.mockReset();
    mocks.removeAvailabilityListener.mockReset();
    mocks.claimInvocation.mockResolvedValue({ claimed: true });
    mocks.completeInvocation.mockResolvedValue(undefined);
    mocks.addAvailabilityListener.mockResolvedValue({
      remove: mocks.removeAvailabilityListener,
    });
    executor = vi.fn(async (received: PendingOneSystemActionInvocation) => ({
      status: "succeeded" as const,
      actionId: received.actionId,
      label: "Share my location",
      routeBefore: "/one/location",
      resultSummary: "Location shared for 2 hours.",
    }));
    unregisterExecutor = registerOneSystemActionExecutor(executor);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (mocks.visible ? "visible" : "hidden"),
    });
  });

  afterEach(() => {
    unregisterExecutor?.();
    unregisterExecutor = null;
  });

  it("claims, executes, and completes an authenticated action exactly once", async () => {
    const pending = invocation();
    mocks.getPendingInvocation.mockResolvedValue(pending);

    render(<SiriOneActionHandoff />);

    await waitFor(() => expect(executor).toHaveBeenCalledWith(pending));
    await waitFor(() =>
      expect(mocks.completeInvocation).toHaveBeenCalledWith({
        id: pending.id,
        outcome: "succeeded",
        summary: "Location shared for 2 hours.",
      }),
    );
    expect(mocks.claimInvocation).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("waits in the background and dispatches after the app becomes active", async () => {
    const pending = invocation({ id: "background-action" });
    mocks.visible = false;
    mocks.getPendingInvocation.mockResolvedValue(pending);

    render(<SiriOneActionHandoff />);
    await waitFor(() => expect(mocks.getPendingInvocation).toHaveBeenCalled());
    expect(mocks.claimInvocation).not.toHaveBeenCalled();

    act(() => {
      mocks.visible = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() =>
      expect(mocks.claimInvocation).toHaveBeenCalledWith({ id: pending.id }),
    );
  });

  it("retains the action through sign-in and restores the original route", async () => {
    const pending = invocation({ id: "auth-restore-action" });
    mocks.auth = { user: null, loading: false };
    mocks.getPendingInvocation.mockResolvedValue(pending);

    const view = render(<SiriOneActionHandoff />);
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/login?redirect=%2Fone%2Flocation%3Fview%3Dpeople",
      ),
    );
    expect(mocks.claimInvocation).not.toHaveBeenCalled();

    mocks.auth = { user: { uid: "user-1" }, loading: false };
    view.rerender(<SiriOneActionHandoff />);

    await waitFor(() => expect(executor).toHaveBeenCalledWith(pending));
  });

  it("waits for vault restoration for mutations but permits UI-only actions", async () => {
    const mutation = invocation({ id: "locked-mutation" });
    mocks.runtime.tier = "signed_locked";
    mocks.getPendingInvocation.mockResolvedValue(mutation);

    const view = render(<SiriOneActionHandoff />);
    await waitFor(() => expect(mocks.getPendingInvocation).toHaveBeenCalled());
    expect(mocks.claimInvocation).not.toHaveBeenCalled();

    mocks.runtime.tier = "signed_unlocked";
    view.rerender(<SiriOneActionHandoff />);
    await waitFor(() => expect(executor).toHaveBeenCalledWith(mutation));
    view.unmount();

    executor.mockClear();
    mocks.claimInvocation.mockClear();
    const navigation = invocation({
      id: "locked-navigation",
      actionId: "location.open_map",
      slots: {},
      requiresVault: false,
      confirmedBySystem: false,
    });
    mocks.runtime.tier = "signed_locked";
    mocks.getPendingInvocation.mockResolvedValue(navigation);
    render(<SiriOneActionHandoff />);
    await waitFor(() => expect(executor).toHaveBeenCalledWith(navigation));
  });

  it("claims locked-vault pause once, opens settings, and cannot replay after unlock", async () => {
    const pending = invocation({
      id: "locked-pause",
      actionId: "location.pause_updates",
      slots: {},
      requiresVault: true,
      confirmedBySystem: false,
    });
    mocks.runtime.tier = "signed_locked";
    mocks.getPendingInvocation.mockResolvedValue(pending);

    const view = render(<SiriOneActionHandoff />);

    await waitFor(() =>
      expect(executor).toHaveBeenCalledWith(
        expect.objectContaining({
          id: pending.id,
          actionId: "location.open_settings",
          slots: {},
          requiresVault: false,
          confirmedBySystem: false,
        }),
      ),
    );
    await waitFor(() =>
      expect(mocks.completeInvocation).toHaveBeenCalledWith({
        id: pending.id,
        outcome: "blocked",
        summary:
          "Unlock Agent One to pause your location. Location settings are open.",
      }),
    );
    expect(mocks.claimInvocation).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[0].actionId).not.toBe(
      "location.pause_updates",
    );

    mocks.runtime.tier = "signed_unlocked";
    view.rerender(<SiriOneActionHandoff />);
    await act(async () => Promise.resolve());

    expect(mocks.claimInvocation).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("expires a cold-launch request without claiming or executing it", async () => {
    const pending = invocation({
      id: "expired-action",
      createdAt: Date.now() - 301_000,
      expiresAt: Date.now() - 1,
    });
    mocks.getPendingInvocation.mockResolvedValue(pending);

    render(<SiriOneActionHandoff />);

    await waitFor(() =>
      expect(mocks.completeInvocation).toHaveBeenCalledWith({
        id: pending.id,
        outcome: "expired",
        summary: "That HUSSH request expired. Try again.",
      }),
    );
    expect(mocks.claimInvocation).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("does not execute twice when native availability repeats", async () => {
    const pending = invocation({ id: "duplicate-action" });
    mocks.getPendingInvocation.mockResolvedValue(pending);
    mocks.claimInvocation
      .mockResolvedValueOnce({ claimed: true })
      .mockResolvedValue({ claimed: false });

    render(<SiriOneActionHandoff />);
    await waitFor(() => expect(executor).toHaveBeenCalledTimes(1));

    const listener = mocks.addAvailabilityListener.mock.calls[0]?.[0] as
      | ((value: PendingOneSystemActionInvocation) => void)
      | undefined;
    act(() => listener?.(pending));
    await waitFor(() => expect(mocks.claimInvocation).toHaveBeenCalledTimes(2));
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
